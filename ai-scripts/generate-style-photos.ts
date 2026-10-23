import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadEnvConfig } from "@next/env";
import { z } from "zod";

import { DEFAULT_TEMPLATE_CONFIG } from "@/lib/catalog/default-template";
import sharp from "sharp";

import { analysePhoto } from "@/lib/garment-photo/align";
import { SegmentationError, skirtRatio, sleeveStyle } from "@/lib/garment-photo/segment";
import { SEED_PRODUCTS, type SeedProduct } from "@/prisma/seed-data";

// Makes the style pictures for the customizable seeded dresses: for every neckline × sleeves × length
// (and a back view per sleeves × length), a photo-like picture of that dress in that style. The dress's
// own catalogue photo (prisma/seed-photos) covers the style it shows, so it isn't drawn. Pictures come from
// Cloudflare Workers AI (FLUX.1 schnell, free tier) and are checked automatically: the sleeves and the
// skirt length are read from the dress's outline (lib/garment-photo), and wrong ones are drawn again.
// Output: prisma/style-photos/<slug>/{front-<neckline>-<sleeves>-<length>,back-<sleeves>-<length>}.jpg,
// which `pnpm db:seed` lines up (lib/garment-photo/align.ts), cuts into parts and turns into templates.
// Re-running only fills in missing pictures.
//
//   pnpm tsx ai-scripts/generate-style-photos.ts                 all dresses, missing pictures only
//   pnpm tsx ai-scripts/generate-style-photos.ts linen-wrap-dress one dress
//   pnpm tsx ai-scripts/generate-style-photos.ts --force          redraw everything
//   pnpm tsx ai-scripts/generate-style-photos.ts --recheck        re-check saved pictures, redraw failures

const MODEL = "@cf/black-forest-labs/flux-1-schnell";
const OUT_DIR = path.join(process.cwd(), "prisma", "style-photos");
const PHOTO_DIR = path.join(process.cwd(), "prisma", "seed-photos");
const MAX_ATTEMPTS = 8;
/** Saved pictures are at most this wide (the design screen shows them 900 px wide). */
const SAVE_WIDTH = 1024;

type Length = "mini" | "midi" | "maxi";
type Style = { neckline: string; sleeveLength: string; dressLength: Length };

const NECKLINE_WORDS: Record<string, string> = { round: "a round crew neckline", "v-neck": "a V-neckline", square: "a square neckline" };
const SLEEVE_WORDS: Record<string, string> = { sleeveless: "no sleeves (sleeveless)", short: "short sleeves", long: "long sleeves down to the wrists" };
const LENGTH_WORDS: Record<Length, string> = { mini: "a short mini skirt ending at mid-thigh, well above the knee", midi: "a midi skirt ending at mid-calf", maxi: "a long maxi skirt reaching the ankles" };
/** Skirt length relative to a midi of the same dress (see skirtRatio). */
const LENGTH_FACTOR: Record<Length, number> = { mini: 0.55, midi: 1, maxi: 1.45 };

export function styleFileName(side: "front" | "back", style: Style): string {
  return side === "front" ? `front-${style.neckline}-${style.sleeveLength}-${style.dressLength}.jpg` : `back-${style.sleeveLength}-${style.dressLength}.jpg`;
}

/** The product description without phrases about necklines, sleeves or length (the style decides those). */
function lookOf(description: string): string {
  return description
    .replace(/\.$/, "")
    .split(/,| and /)
    .map((part) => part.trim())
    .filter((part) => part && !/sleeve|neck|length|mini|midi|maxi|knee|floor|strap|halter/i.test(part))
    .join(", ");
}

function prompt(product: SeedProduct, colour: string, side: "front" | "back", style: Style): string {
  return [
    `Professional e-commerce catalogue photo of a women's ${product.name.toLowerCase()} in ${colour.toLowerCase()} colour: ${lookOf(product.description)}.`,
    `This dress has ${NECKLINE_WORDS[style.neckline] ?? style.neckline}, ${SLEEVE_WORDS[style.sleeveLength] ?? style.sleeveLength} and ${LENGTH_WORDS[style.dressLength]}.`,
    `One single dress only, on a cream dress-form mannequin on a thin stand, ${side === "back" ? "seen from the back" : "full-length front view"}, centred, the whole dress visible with space around it,`,
    "plain light grey seamless studio background, soft even lighting, realistic fabric texture. No person, no face, no text, no logo, no watermark.",
  ].join(" ");
}

async function flux(env: { CLOUDFLARE_ACCOUNT_ID: string; CLOUDFLARE_API_TOKEN: string }, text: string): Promise<Buffer | "limit" | null> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${MODEL}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
    body: JSON.stringify({ prompt: text, steps: 8 }),
  });
  if (response.status === 429) return "limit";
  const body = z.object({ result: z.object({ image: z.string() }).optional() }).safeParse(await response.json().catch(() => null));
  const image = body.success ? body.data.result?.image : undefined;
  return response.ok && image ? Buffer.from(image, "base64") : null;
}

type Check = { ok: true } | { ok: false; problem: string };

/** Whether a picture shows the requested sleeves and length, with the whole dress in frame. */
async function checkPicture(image: Buffer, style: Style, midiRatio: number): Promise<Check> {
  try {
    const { parts } = await analysePhoto(image);
    const sleeves = sleeveStyle(parts);
    const ratio = skirtRatio(parts);
    const length = (Object.keys(LENGTH_FACTOR) as Length[]).reduce((best, l) =>
      Math.abs(Math.log(ratio / (midiRatio * LENGTH_FACTOR[l]))) < Math.abs(Math.log(ratio / (midiRatio * LENGTH_FACTOR[best]))) ? l : best,
    );
    const framed = parts.shoulderY > 4 && parts.hemY < parts.garment.height - 4;
    if (sleeves === style.sleeveLength && length === style.dressLength && framed) return { ok: true };
    return { ok: false, problem: `got ${sleeves}/${length}${framed ? "" : "/cut off"}` };
  } catch (error) {
    if (error instanceof SegmentationError) return { ok: false, problem: error.message };
    throw error;
  }
}

function log(fields: Record<string, string | number | boolean | null>) {
  console.log(JSON.stringify(fields));
}

async function main() {
  loadEnvConfig(process.cwd());
  const env = z.object({ CLOUDFLARE_ACCOUNT_ID: z.string().min(10), CLOUDFLARE_API_TOKEN: z.string().min(10) }).parse(process.env);
  const force = process.argv.includes("--force");
  const recheck = process.argv.includes("--recheck");
  const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const options = DEFAULT_TEMPLATE_CONFIG.styleOptions;

  for (const product of SEED_PRODUCTS) {
    const photoStyle = product.photoStyle;
    if (!product.customizable || !photoStyle || (only.length > 0 && !only.includes(product.slug))) continue;
    const dir = path.join(OUT_DIR, product.slug);
    await mkdir(dir, { recursive: true });
    // The catalogue photo was made in the first colour alphabetically (ai-scripts/generate-dress-photos.ts).
    const colour = [...product.colors].sort((a, b) => a.name.localeCompare(b.name))[0]?.name ?? "neutral";
    const photo = await readFile(path.join(PHOTO_DIR, `${product.slug}.jpg`));
    const realRatio = skirtRatio((await analysePhoto(photo)).parts);
    const midiRatio = realRatio / LENGTH_FACTOR[photoStyle.dressLength];

    const jobs: { side: "front" | "back"; style: Style }[] = [];
    for (const neckline of options.neckline.map((o) => o.id)) {
      for (const sleeveLength of options.sleeveLength.map((o) => o.id)) {
        for (const dressLength of options.dressLength.map((o) => o.id) as Length[]) {
          jobs.push({ side: "front", style: { neckline, sleeveLength, dressLength } });
          if (neckline === options.neckline[0]?.id) jobs.push({ side: "back", style: { neckline, sleeveLength, dressLength } });
        }
      }
    }

    for (const { side, style } of jobs) {
      const out = path.join(dir, styleFileName(side, style));
      if (existsSync(out) && recheck) {
        const check = await checkPicture(await readFile(out), style, midiRatio);
        if (check.ok) continue;
        log({ slug: product.slug, file: path.basename(out), recheck: check.problem });
        await rm(out);
      }
      if (existsSync(out) && !force) continue;
      const isPhoto = side === "front" && style.neckline === photoStyle.neckline && style.sleeveLength === photoStyle.sleeveLength && style.dressLength === photoStyle.dressLength;
      if (isPhoto) continue; // the seed uses the catalogue photo itself
      let saved = false;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !saved; attempt += 1) {
        const image = await flux(env, prompt(product, colour, side, style));
        if (image === "limit") {
          log({ slug: product.slug, stopped: "Cloudflare daily limit reached; run again later to continue" });
          return;
        }
        if (!image) {
          log({ slug: product.slug, file: path.basename(out), attempt, problem: "no image" });
          continue;
        }
        const check = await checkPicture(image, style, midiRatio);
        if (!check.ok) {
          log({ slug: product.slug, file: path.basename(out), attempt, problem: check.problem });
          continue;
        }
        await writeFile(out, await sharp(image).resize({ width: SAVE_WIDTH, withoutEnlargement: true }).jpeg({ quality: 86, mozjpeg: true }).toBuffer());
        log({ slug: product.slug, file: path.basename(out), attempt, source: "ai" });
        saved = true;
      }
      if (!saved) log({ slug: product.slug, file: path.basename(out), failed: true });
    }
  }
}

void main();
