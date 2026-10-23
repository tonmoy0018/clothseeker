import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { loadEnvConfig } from "@next/env";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { createPrismaClient, type PrismaClient } from "@/lib/db/client";
import type { Role } from "@/lib/generated/prisma/enums";
import { serverEnvSchema, parseEnv } from "@/lib/env/schema";
import { storeProductImage } from "@/lib/admin/media";
import { majorToMinor } from "@/lib/money";
import { DEFAULT_TEMPLATE_CONFIG } from "@/lib/catalog/default-template";
import { BUCKETS } from "@/lib/storage/buckets";
import { buildObjectKey } from "@/lib/storage/object-key";
import { SupabaseStorageAdapter } from "@/lib/storage/supabase-core";
import { parseTemplateConfig, templateConfigSchema, templateImageKeys, type TemplateConfig } from "@/types/template";

import { renderGarment, renderMask, SEED_REGIONS, SEED_SKIRT_AREA, SEED_STYLE_IDS, seedStyles, type SeedRegion } from "./seed-garments";
import {
  SEED_CATEGORIES,
  SEED_PRODUCTS,
  seedStock,
  sizeSurchargeTaka,
  type SeedProduct,
} from "./seed-data";
import { fitPrintAreas, PHOTO_REGIONS, photoPictures, styleFiles, type PhotoRegion } from "./seed-style-photos";

/** AI-generated sample catalog photos, one per seeded dress (see ai-scripts/generate-dress-photos.ts). */
const SEED_PHOTOS_DIR = path.join(process.cwd(), "prisma", "seed-photos");
/** `pnpm db:seed -- --redraw-templates` rebuilds every seeded template's pictures (after changing how they're made). */
const REDRAW = process.argv.includes("--redraw-templates");

// Idempotent demo seed: 1 admin, 3 customers, 5 categories, 15 dresses (+1 draft), 5 templates.
// Run with `pnpm db:seed`. Refuses non-local databases unless `--allow-remote` is passed.

const SEED_USERS: readonly { email: string; name: string; role: Role }[] = [
  { email: "admin@clothseeker.test", name: "ClothSeeker Admin", role: "ADMIN" },
  { email: "ava@example.test", name: "Ava Rahman", role: "CUSTOMER" },
  { email: "noah@example.test", name: "Noah Karim", role: "CUSTOMER" },
  { email: "mia@example.test", name: "Mia Chowdhury", role: "CUSTOMER" },
];

function log(msg: string, fields: Record<string, string | number> = {}): void {
  console.log(JSON.stringify({ level: "info", msg, ...fields }));
}

async function ensureAuthUser(supabase: SupabaseClient, email: string, password: string): Promise<string> {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) {
      throw new Error(`Could not list auth users: ${error.name}`);
    }
    const found = data.users.find((u) => u.email?.toLowerCase() === email);
    if (found) {
      // Reset to the documented demo password so demo logins always work.
      const updated = await supabase.auth.admin.updateUserById(found.id, { password, email_confirm: true });
      if (updated.error) {
        throw new Error(`Could not update auth user: ${updated.error.name}`);
      }
      return found.id;
    }
    if (data.users.length < 200) {
      break;
    }
  }
  const created = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) {
    throw new Error(`Could not create auth user: ${created.error?.name ?? "unknown"}`);
  }
  return created.data.user.id;
}

async function seedUsers(db: PrismaClient, supabase: SupabaseClient, password: string): Promise<void> {
  for (const user of SEED_USERS) {
    const id = await ensureAuthUser(supabase, user.email, password);
    await db.user.upsert({
      where: { id },
      create: { id, email: user.email, name: user.name, role: user.role },
      update: { email: user.email, name: user.name, role: user.role },
    });
  }
  log("seed.users", { count: SEED_USERS.length });
}

async function uploadSeedImage(supabase: SupabaseClient, productId: string, data: Buffer, extension: "webp" | "png"): Promise<string> {
  const key = buildObjectKey(BUCKETS.productMedia, { ownerId: productId, category: "template", extension });
  const { error } = await supabase.storage
    .from(BUCKETS.productMedia)
    .upload(key, data, { contentType: extension === "png" ? "image/png" : "image/webp", upsert: false });
  if (error) {
    throw new Error(`Could not upload seed template image: ${error.name}`);
  }
  return key;
}

/** Uploads seed images for one product, uploading identical images (e.g. a shared mask) once. */
function uploader(supabase: SupabaseClient, productId: string) {
  const uploaded = new Map<string, string>();
  return async (data: Buffer, extension: "webp" | "png"): Promise<string> => {
    const hash = createHash("sha256").update(data).digest("hex");
    let key = uploaded.get(hash);
    if (!key) {
      key = await uploadSeedImage(supabase, productId, data, extension);
      uploaded.set(hash, key);
    }
    return key;
  };
}

type TemplateBuild = { config: TemplateConfig; drawn: boolean; replaced: string[] };

/**
 * Seeded templates, with a garment picture (and masks) for every neckline × sleeve × length so the
 * preview changes with the style:
 * - dresses with a `photoStyle` get photo templates: their catalogue photo plus whatever AI style
 *   pictures exist in prisma/style-photos/<slug> (missing styles show the closest picture), recoloured
 *   with the photo's own light and shadow ("shade");
 * - any others get drawn garments (prisma/seed-garments.ts).
 * A template that already has the right kind and number of pictures keeps all its images, so re-seeding
 * doesn't duplicate files. Otherwise the pictures are (re)built and the old images are returned in
 * `replaced` for deletion.
 */
async function templateConfigFor(db: PrismaClient, supabase: SupabaseClient, product: SeedProduct, productId: string): Promise<TemplateBuild> {
  const existing = await db.customizationTemplate.findUnique({ where: { productId }, select: { config: true } });
  const current = existing ? parseTemplateConfig(existing.config) : null;
  const photoStyle = product.photoStyle;
  const photoFiles = photoStyle ? await styleFiles(product.slug) : [];

  if (photoStyle) {
    // The catalogue photo is one more picture than the style files.
    if (!REDRAW && current && current.recolor === "shade" && current.styleVariants.length === photoFiles.length + 1) {
      return { config: templateConfigSchema.parse({ ...DEFAULT_TEMPLATE_CONFIG, ...pick(current), defaultStyle: photoStyle, recolor: "shade" }), drawn: false, replaced: [] };
    }
    return withReplaced(current, await photoTemplate(supabase, product, photoStyle, productId));
  }

  const placementAreas = DEFAULT_TEMPLATE_CONFIG.placementAreas.map((area) => (area.id === "front-skirt" ? { ...area, ...SEED_SKIRT_AREA } : area));
  const base = { ...DEFAULT_TEMPLATE_CONFIG, placementAreas };
  if (!REDRAW && current && current.recolor === "multiply" && current.styleVariants.length > 0) {
    const config = templateConfigSchema.parse({ ...base, garmentImages: current.garmentImages, regions: current.regions, styleVariants: current.styleVariants });
    return { config, drawn: false, replaced: [] };
  }
  return withReplaced(current, await drawnTemplate(supabase, base, productId));
}

/** The picture-related fields of an existing template, kept when re-seeding. */
function pick(config: TemplateConfig) {
  return { garmentImages: config.garmentImages, regions: config.regions, styleVariants: config.styleVariants, placementAreas: config.placementAreas };
}

function withReplaced(current: TemplateConfig | null, config: TemplateConfig): TemplateBuild {
  const kept = new Set(templateImageKeys(config));
  const replaced = current ? templateImageKeys(current).filter((key) => !kept.has(key)) : [];
  return { config, drawn: true, replaced };
}

async function photoTemplate(
  supabase: SupabaseClient,
  product: SeedProduct,
  photoStyle: NonNullable<SeedProduct["photoStyle"]>,
  productId: string,
): Promise<TemplateConfig> {
  const upload = uploader(supabase, productId);
  const pictures = await photoPictures({ ...product, photoStyle });
  const styleVariants: TemplateConfig["styleVariants"] = [];
  const keys: Partial<Record<PhotoRegion, string>>[] = [];
  for (const p of pictures) {
    const masks: Partial<Record<PhotoRegion, string>> = {};
    for (const { id } of PHOTO_REGIONS) {
      const mask = p.masks[id];
      if (mask) masks[id] = await upload(mask, "png");
    }
    keys.push(masks);
    styleVariants.push({ side: p.side, match: p.match, image: await upload(p.image, "webp"), masks });
  }

  // The template's own images: the catalogue photo, and the back view in the same sleeves and length.
  const backIndex = Math.max(
    0,
    styleVariants.findIndex((v) => v.side === "back" && v.match.sleeveLength === photoStyle.sleeveLength && v.match.dressLength === photoStyle.dressLength),
  );
  const front = styleVariants[0];
  const back = styleVariants[backIndex]?.side === "back" ? styleVariants[backIndex] : styleVariants.find((v) => v.side === "back");
  const regions: TemplateConfig["regions"] = PHOTO_REGIONS.map(({ id, label }) => ({
    id,
    label,
    recolorable: true,
    masks: { front: front?.masks[id], back: back?.masks[id] },
  }));

  return templateConfigSchema.parse({
    ...DEFAULT_TEMPLATE_CONFIG,
    placementAreas: fitPrintAreas(pictures),
    garmentImages: { front: front?.image, back: back?.image },
    regions,
    styleVariants,
    recolor: "shade",
    defaultStyle: photoStyle,
  });
}

async function drawnTemplate(supabase: SupabaseClient, base: TemplateConfig, productId: string): Promise<TemplateConfig> {
  const upload = uploader(supabase, productId);
  const styleVariants: TemplateConfig["styleVariants"] = [];
  for (const style of seedStyles()) {
    for (const side of ["front", "back"] as const) {
      // The back looks the same for every neckline: one picture per sleeve × length.
      if (side === "back" && style.neckline !== SEED_STYLE_IDS.neckline[0]) {
        continue;
      }
      const masks: Record<string, string> = {};
      for (const { id } of SEED_REGIONS) {
        masks[id] = await upload(await renderMask(side, style, id), "png");
      }
      const match = side === "front" ? style : { sleeveLength: style.sleeveLength, dressLength: style.dressLength };
      styleVariants.push({ side, match, image: await upload(await renderGarment(side, style), "webp"), masks });
    }
  }

  // The template's own images are the first options' picture (also shown in the admin editor).
  const first = { neckline: SEED_STYLE_IDS.neckline[0], sleeveLength: SEED_STYLE_IDS.sleeveLength[0], dressLength: SEED_STYLE_IDS.dressLength[0] };
  const garmentImages: TemplateConfig["garmentImages"] = {};
  const regions: TemplateConfig["regions"] = SEED_REGIONS.map(({ id, label }) => ({ id, label, recolorable: true, masks: {} }));
  for (const side of ["front", "back"] as const) {
    garmentImages[side] = await upload(await renderGarment(side, first), "webp");
    for (const region of regions) {
      region.masks[side] = await upload(await renderMask(side, first, region.id as SeedRegion), "png");
    }
  }
  return templateConfigSchema.parse({ ...base, garmentImages, regions, styleVariants });
}

async function seedCatalog(db: PrismaClient, supabase: SupabaseClient): Promise<void> {

  for (const category of SEED_CATEGORIES) {
    await db.category.upsert({
      where: { slug: category.slug },
      create: category,
      update: { name: category.name, sortOrder: category.sortOrder },
    });
  }

  let variantCount = 0;
  let photoCount = 0;
  let templatesDrawn = 0;
  const storage = new SupabaseStorageAdapter(() => supabase);
  for (const [productIndex, p] of SEED_PRODUCTS.entries()) {
    const category = await db.category.findUniqueOrThrow({ where: { slug: p.category }, select: { id: true } });
    const product = await db.product.upsert({
      where: { slug: p.slug },
      create: {
        slug: p.slug,
        name: p.name,
        description: p.description,
        categoryId: category.id,
        status: p.status ?? "ACTIVE",
      },
      update: { name: p.name, description: p.description, categoryId: category.id, status: p.status ?? "ACTIVE" },
      select: { id: true, imageKeys: true },
    });
    // AI-generated sample catalog photo (prisma/seed-photos, ai-scripts/generate-dress-photos.ts),
    // only for dresses without photos, so photos uploaded by the team are never replaced.
    const samplePhoto = path.join(SEED_PHOTOS_DIR, `${p.slug}.jpg`);
    if (product.imageKeys.length === 0 && existsSync(samplePhoto)) {
      const key = await storeProductImage(storage, product.id, await readFile(samplePhoto), "productPhoto", "photos");
      await db.product.update({ where: { id: product.id }, data: { imageKeys: [key] } });
      photoCount += 1;
    }

    for (const [sizeIndex, size] of p.sizes.entries()) {
      for (const [colorIndex, color] of p.colors.entries()) {
        const sku = `CS-${String(productIndex + 1).padStart(2, "0")}-${size}-${color.name.toUpperCase().replaceAll(" ", "")}`;
        const data = {
          productId: product.id,
          size,
          colorName: color.name,
          colorHex: color.hex,
          priceMinor: majorToMinor(p.priceTaka + sizeSurchargeTaka(size)),
          stock: seedStock(productIndex, sizeIndex, colorIndex),
          isActive: true,
        };
        await db.variant.upsert({ where: { sku }, create: { sku, ...data }, update: data });
        variantCount += 1;
      }
    }

    if (p.customizable) {
      const { config, drawn, replaced } = await templateConfigFor(db, supabase, p, product.id);
      await db.customizationTemplate.upsert({
        where: { productId: product.id },
        create: { productId: product.id, version: 1, config, aiEnabled: true, isActive: true },
        // New pictures are a new template version, so an open admin editor can't overwrite them.
        update: { config, aiEnabled: true, isActive: true, ...(drawn ? { version: { increment: 1 } } : {}) },
      });
      if (replaced.length > 0) {
        await storage.remove(BUCKETS.productMedia, replaced);
      }
      if (drawn) {
        templatesDrawn += 1;
      }
    }
  }
  log("seed.catalog", {
    categories: SEED_CATEGORIES.length,
    products: SEED_PRODUCTS.length,
    variants: variantCount,
    templates: SEED_PRODUCTS.filter((p) => p.customizable).length,
    photosAdded: photoCount,
    templatesDrawn,
  });
}

function assertLocalDatabase(databaseUrl: string): void {
  const host = new URL(databaseUrl).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && !process.argv.includes("--allow-remote")) {
    throw new Error("Refusing to seed a non-local database. Pass --allow-remote if you really mean it.");
  }
}

async function main(): Promise<void> {
  loadEnvConfig(process.cwd());
  const env = parseEnv(serverEnvSchema, process.env, "server");
  const { SEED_DEMO_PASSWORD: password } = parseEnv(
    z.object({ SEED_DEMO_PASSWORD: z.string().min(8) }),
    process.env,
    "seed",
  );
  assertLocalDatabase(env.DATABASE_URL);

  const db = createPrismaClient(env.DATABASE_URL);
  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  try {
    await seedUsers(db, supabase, password);
    await seedCatalog(db, supabase);
    log("seed.done");
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ level: "error", msg: "seed.failed", error: error instanceof Error ? error.message : "unknown" }));
  process.exit(1);
});
