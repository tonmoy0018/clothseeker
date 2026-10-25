import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadEnvConfig } from "@next/env";
import { z } from "zod";

import sharp from "sharp";

import { defaultTemplateConfig } from "@/lib/catalog/default-template";
import { GARMENT_TYPES, STYLE_GROUP_IDS, styleGroupsOf, type GarmentType, type StyleGroup } from "@/lib/catalog/garment-types";
import { analysePhoto } from "@/lib/garment-photo/align";
import { lengthRatio, SegmentationError, skirtRatio, sleeveStyle, widthAt, type GarmentParts } from "@/lib/garment-photo/segment";
import { pictureGroups, styleCombinations, styleFileName, type Side, type StyleChoice } from "@/lib/garment-photo/style-files";
import { styleOptionsFor } from "@/types/template";
import { photoColour, SEED_PRODUCTS, type SeedProduct } from "@/prisma/seed-data";

// Makes the style pictures for the customizable seeded items: for every combination of their garment
// type's style choices (and back views, which ignore the neckline or collar), a photo-like picture of that
// item in that style. The item's own catalogue photo (prisma/seed-photos) covers the style it shows, so
// it isn't drawn. Pictures come from Cloudflare Workers AI (FLUX.1 schnell, free tier) and are checked
// automatically: sleeves and length are read from the garment's outline (lib/garment-photo), and wrong
// ones are drawn again. Output: prisma/style-photos/<slug>/<side>--<choice>--….jpg (lib/garment-photo/
// style-files.ts), which `pnpm db:seed` lines up, cuts into parts and turns into templates.
// Re-running only fills in missing pictures; Cloudflare's free tier allows about 150 a day.
//
//   pnpm tsx ai-scripts/generate-style-photos.ts                 all items, missing pictures only
//   pnpm tsx ai-scripts/generate-style-photos.ts oxford-shirt    one item
//   pnpm tsx ai-scripts/generate-style-photos.ts --force          redraw everything
//   pnpm tsx ai-scripts/generate-style-photos.ts --recheck        re-check saved pictures, redraw failures

const MODEL = "@cf/black-forest-labs/flux-1-schnell";
const OUT_DIR = path.join(process.cwd(), "prisma", "style-photos");
const PHOTO_DIR = path.join(process.cwd(), "prisma", "seed-photos");
const MAX_ATTEMPTS = 8;
/** Saved pictures are at most this wide (the design screen shows them 900 px wide). */
const SAVE_WIDTH = 1024;

/** How each style option is described to the image model. */
const WORDS: Partial<Record<StyleGroup, Record<string, string>>> = {
  neckline: { round: "a round crew neckline", "v-neck": "a V-neckline", square: "a square neckline" },
  sleeveLength: {
    sleeveless: "no sleeves (sleeveless)",
    short: "short sleeves",
    long: "long sleeves down to the wrists",
    "three-quarter": "three-quarter sleeves ending just below the elbow",
  },
  dressLength: { mini: "a short mini skirt ending at mid-thigh, well above the knee", midi: "a midi skirt ending at mid-calf", maxi: "a long maxi skirt reaching the ankles" },
  collar: {
    classic: "a classic point collar",
    "button-down": "a button-down collar",
    mandarin: "a short standing band (mandarin) collar",
    round: "a round collarless neckline with a short front placket",
    "v-placket": "a V-shaped placket neckline",
  },
  fit: { slim: "a slim fit tapered at the waist", regular: "a regular straight fit", relaxed: "a relaxed, loose boxy fit" },
  length: { hip: "a short hip-length hem", knee: "a knee-length hem", long: "a long hem reaching mid-calf" },
};

/** What the garment is shown on, per type. */
const MOUNT: Record<GarmentType, string> = {
  dress: "on a cream dress-form mannequin on a thin stand",
  shirt: "on an invisible ghost mannequin",
  panjabi: "on an invisible ghost mannequin",
};

/** The product description without phrases about style details (the style choices decide those). */
function lookOf(description: string): string {
  return description
    .replace(/\.$/, "")
    .split(/,| and /)
    .map((part) => part.trim())
    .filter((part) => part && !/sleeve|neck|length|mini|midi|maxi|knee|floor|strap|halter|collar|fit\b|placket/i.test(part))
    .join(", ");
}

function prompt(product: SeedProduct, type: GarmentType, colour: string, side: Side, choice: StyleChoice): string {
  const info = GARMENT_TYPES[type];
  const details = pictureGroups(type, side).map((g) => WORDS[g]?.[choice[g] ?? ""] ?? choice[g] ?? "");
  return [
    `Professional e-commerce catalogue photo of a ${info.audience === "men" ? "men's" : "women's"} ${product.name.toLowerCase()} in ${colour.toLowerCase()} colour: ${lookOf(product.description)}.`,
    `This ${info.noun} has ${details.join(", ")}.`,
    `One single ${info.noun} only, ${MOUNT[type]}, ${side === "back" ? "seen from the back" : "full-length front view"}, centred, the whole ${info.noun} visible with space around it,`,
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

/** Dress skirt length relative to a midi of the same dress (see skirtRatio). */
const DRESS_LENGTH_FACTOR: Record<string, number> = { mini: 0.55, midi: 1, maxi: 1.45 };
/** Panjabi length relative to a knee-length one of the same panjabi (see lengthRatio). */
const PANJABI_LENGTH_FACTOR: Record<string, number> = { hip: 0.68, knee: 1, long: 1.25 };

/** The factor closest to `ratio / base`. */
function nearest(ratio: number, base: number, factors: Record<string, number>): string {
  let best = "";
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [id, factor] of Object.entries(factors)) {
    const distance = Math.abs(Math.log(ratio / (base * factor)));
    if (distance < bestDistance) {
      best = id;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Shirt and panjabi sleeves from the outline's width: hanging long sleeves make the garment wide at
 * mid-height; three-quarter sleeves only higher up (calibrated on the catalogue photos).
 */
function menSleeves(type: GarmentType, parts: GarmentParts): string {
  const wide = (fraction: number) => widthAt(parts, fraction) > 1.15;
  if (type === "shirt") return wide(0.5) ? "long" : "short";
  return wide(0.45) ? "long" : wide(0.3) ? "three-quarter" : "short";
}

type Reference = { type: GarmentType; base: number };

/** The catalogue photo's measurement, scaled to the reference style (midi dress, knee-length panjabi). */
function referenceFor(type: GarmentType, parts: GarmentParts, photoStyle: StyleChoice): Reference {
  if (type === "dress") return { type, base: skirtRatio(parts) / (DRESS_LENGTH_FACTOR[photoStyle.dressLength ?? "midi"] ?? 1) };
  if (type === "panjabi") return { type, base: lengthRatio(parts) / (PANJABI_LENGTH_FACTOR[photoStyle.length ?? "knee"] ?? 1) };
  return { type, base: 1 };
}

/**
 * Whether a picture shows the requested sleeves and length, with the whole garment in frame. Collars,
 * necklines and fit can't be read reliably from an outline, so they're left to the prompt.
 */
async function checkPicture(image: Buffer, side: Side, choice: StyleChoice, ref: Reference): Promise<Check> {
  try {
    const { parts } = await analysePhoto(image);
    const got: StyleChoice = {};
    if (ref.type === "dress") {
      got.sleeveLength = sleeveStyle(parts);
      got.dressLength = nearest(skirtRatio(parts), ref.base, DRESS_LENGTH_FACTOR);
    } else {
      // From the back, a ghost-mannequin shirt's short sleeves often read as long (the back panel is
      // wide): back views of shirts and panjabis aren't checked for sleeves.
      if (side === "front") got.sleeveLength = menSleeves(ref.type, parts);
      if (ref.type === "panjabi") got.length = nearest(lengthRatio(parts), ref.base, PANJABI_LENGTH_FACTOR);
    }
    const wrong = STYLE_GROUP_IDS.filter((g) => got[g] !== undefined && choice[g] !== undefined && got[g] !== choice[g]);
    const framed = parts.shoulderY > 4 && parts.hemY < parts.garment.height - 4;
    if (wrong.length === 0 && framed) return { ok: true };
    return { ok: false, problem: `got ${Object.values(got).join("/")}${framed ? "" : "/cut off"}` };
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

  for (const product of SEED_PRODUCTS) {
    const photoStyle = product.photoStyle;
    if (!product.customizable || !photoStyle || (only.length > 0 && !only.includes(product.slug))) continue;
    const type = product.garmentType ?? "dress";
    const template = defaultTemplateConfig(type);
    const photoPath = path.join(PHOTO_DIR, `${product.slug}.jpg`);
    if (!existsSync(photoPath)) {
      log({ slug: product.slug, skipped: "no catalogue photo yet (run ai-scripts/generate-dress-photos.ts first)" });
      continue;
    }
    const dir = path.join(OUT_DIR, product.slug);
    await mkdir(dir, { recursive: true });
    const colour = photoColour(product);
    const ref = referenceFor(type, (await analysePhoto(await readFile(photoPath))).parts, photoStyle);
    const options = Object.fromEntries(styleGroupsOf(type).map((g) => [g, styleOptionsFor(template, g).map((o) => o.id)]));
    const jobs = styleCombinations(type, options);

    for (const { side, choice } of jobs) {
      const out = path.join(dir, styleFileName(type, side, choice));
      if (existsSync(out) && recheck) {
        const check = await checkPicture(await readFile(out), side, choice, ref);
        if (check.ok) continue;
        log({ slug: product.slug, file: path.basename(out), recheck: check.problem });
        await rm(out);
      }
      if (existsSync(out) && !force) continue;
      const isPhoto = side === "front" && styleGroupsOf(type).every((g) => choice[g] === photoStyle[g]);
      if (isPhoto) continue; // the seed uses the catalogue photo itself
      let saved = false;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !saved; attempt += 1) {
        const image = await flux(env, prompt(product, type, colour, side, choice));
        if (image === "limit") {
          log({ slug: product.slug, stopped: "Cloudflare daily limit reached; run again later to continue" });
          return;
        }
        if (!image) {
          log({ slug: product.slug, file: path.basename(out), attempt, problem: "no image" });
          continue;
        }
        const check = await checkPicture(image, side, choice, ref);
        if (!check.ok) {
          // Kept outside the repo, to see why pictures are refused.
          const rejects = path.join(tmpdir(), "clothseeker-style-rejects", product.slug);
          await mkdir(rejects, { recursive: true });
          await writeFile(path.join(rejects, `${path.basename(out, ".jpg")}-${attempt}.jpg`), image);
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
