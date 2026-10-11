import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { loadEnvConfig } from "@next/env";
import sharp from "sharp";
import { z } from "zod";

import { createPrismaClient } from "@/lib/db/client";

// Generates AI sample catalog photos for the seeded dresses with Cloudflare Workers AI (FLUX.1
// schnell, free tier) and saves them to prisma/seed-photos/<slug>.jpg, which `pnpm db:seed` uploads.
// The dress is shown on an invisible "ghost" mannequin: no person, no face.
// These are SAMPLE photos made by AI: replace them with real photos of ClothSeeker dresses.
//
//   pnpm tsx ai-scripts/generate-dress-photos.ts            missing photos only
//   pnpm tsx ai-scripts/generate-dress-photos.ts --force    regenerate all

const OUT_DIR = path.join(process.cwd(), "prisma", "seed-photos");
const MODEL = "@cf/black-forest-labs/flux-1-schnell";

function prompt(name: string, description: string, color: string): string {
  return [
    `Professional e-commerce catalog photo of a women's ${name.toLowerCase()} in ${color.toLowerCase()} colour.`,
    description,
    "One single dress only, shown on an invisible ghost mannequin, full-length front view, centred, the whole dress visible,",
    "plain light grey seamless studio background, soft even lighting, realistic fabric texture.",
    "No person, no face, no text, no logo, no watermark.",
  ].join(" ");
}

async function main() {
  loadEnvConfig(process.cwd());
  const env = z.object({ DATABASE_URL: z.string(), CLOUDFLARE_ACCOUNT_ID: z.string().min(10), CLOUDFLARE_API_TOKEN: z.string().min(10) }).parse(process.env);
  const force = process.argv.includes("--force");
  const db = createPrismaClient(env.DATABASE_URL);
  try {
    const products = await db.product.findMany({
      where: { status: "ACTIVE" },
      orderBy: { slug: "asc" },
      select: { slug: true, name: true, description: true, variants: { orderBy: { colorName: "asc" }, select: { colorName: true }, take: 1 } },
    });
    for (const product of products) {
      const out = path.join(OUT_DIR, `${product.slug}.jpg`);
      if (existsSync(out) && !force) {
        console.log(JSON.stringify({ slug: product.slug, skipped: true }));
        continue;
      }
      const color = product.variants[0]?.colorName ?? "neutral";
      let saved = false;
      // The free model's safety filter occasionally refuses harmless prompts; a reworded retry helps.
      for (const [attempt, text] of [prompt(product.name, product.description, color), prompt(product.name, "", color)].entries()) {
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
