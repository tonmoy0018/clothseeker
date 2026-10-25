import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { loadEnvConfig } from "@next/env";
import sharp from "sharp";
import { z } from "zod";

import { GARMENT_TYPES, type GarmentType } from "@/lib/catalog/garment-types";
import { createPrismaClient } from "@/lib/db/client";
import { photoColour, SEED_PRODUCTS } from "@/prisma/seed-data";

// Generates AI sample catalog photos for the seeded items (dresses, shirts, panjabis) with Cloudflare Workers AI (FLUX.1
// schnell, free tier) and saves them to prisma/seed-photos/<slug>.jpg, which `pnpm db:seed` uploads.
// The dress is shown on an invisible "ghost" mannequin: no person, no face.
// These are SAMPLE photos made by AI: replace them with real photos of ClothSeeker dresses.
//
//   pnpm tsx ai-scripts/generate-dress-photos.ts            missing photos only
//   pnpm tsx ai-scripts/generate-dress-photos.ts --force    regenerate all
//   pnpm tsx ai-scripts/generate-dress-photos.ts --force oxford-shirt   regenerate one

const OUT_DIR = path.join(process.cwd(), "prisma", "seed-photos");
const MODEL = "@cf/black-forest-labs/flux-1-schnell";

function prompt(name: string, description: string, color: string, type: GarmentType): string {
  const info = GARMENT_TYPES[type];
  return [
    `Professional e-commerce catalog photo of a ${info.audience === "men" ? "men's" : "women's"} ${name.toLowerCase()} in ${color.toLowerCase()} colour.`,
    description,
    `One single ${info.noun} only, shown on an invisible ghost mannequin, full-length front view, centred, the whole ${info.noun} visible,`,
    "plain light grey seamless studio background, soft even lighting, realistic fabric texture.",
    "No person, no face, no text, no logo, no watermark.",
  ].join(" ");
}

async function main() {
  loadEnvConfig(process.cwd());
  const env = z.object({ DATABASE_URL: z.string(), CLOUDFLARE_ACCOUNT_ID: z.string().min(10), CLOUDFLARE_API_TOKEN: z.string().min(10) }).parse(process.env);
  const force = process.argv.includes("--force");
  const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const db = createPrismaClient(env.DATABASE_URL);
  try {
    const products = await db.product.findMany({
      where: { status: "ACTIVE" },
      orderBy: { slug: "asc" },
      select: { slug: true, name: true, description: true, garmentType: true, variants: { orderBy: { colorName: "asc" }, select: { colorName: true }, take: 1 } },
    });
    for (const product of products) {
      const out = path.join(OUT_DIR, `${product.slug}.jpg`);
      if (only.length > 0 && !only.includes(product.slug)) continue;
      if (existsSync(out) && !force) {
        console.log(JSON.stringify({ slug: product.slug, skipped: true }));
        continue;
      }
      // The seed data can name the colour (e.g. one that stands out from the studio backdrop).
      const seed = SEED_PRODUCTS.find((p) => p.slug === product.slug);
      const color = seed ? photoColour(seed) : (product.variants[0]?.colorName ?? "neutral");
      let saved = false;
      // The free model's safety filter occasionally refuses harmless prompts; a reworded retry helps.
      for (const [attempt, text] of [prompt(product.name, product.description, color, product.garmentType), prompt(product.name, "", color, product.garmentType)].entries()) {
        const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${MODEL}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
          body: JSON.stringify({ prompt: text, steps: 8 }),
        });
        const body = z.object({ result: z.object({ image: z.string() }).optional() }).safeParse(await response.json().catch(() => null));
        const image = body.success ? body.data.result?.image : undefined;
        if (response.ok && image) {
          const jpg = await sharp(Buffer.from(image, "base64")).jpeg({ quality: 84, mozjpeg: true }).toBuffer();
          await writeFile(out, jpg);
          console.log(JSON.stringify({ slug: product.slug, color, attempt, bytes: jpg.length }));
          saved = true;
          break;
        }
        console.log(JSON.stringify({ slug: product.slug, attempt, status: response.status, retrying: attempt === 0 }));
      }
      if (!saved) console.log(JSON.stringify({ slug: product.slug, failed: true }));
    }
  } finally {
    await db.$disconnect();
  }
}

void main();
