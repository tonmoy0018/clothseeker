import { loadEnvConfig } from "@next/env";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { createPrismaClient, type PrismaClient } from "@/lib/db/client";
import type { Role } from "@/lib/generated/prisma/enums";
import { serverEnvSchema, parseEnv } from "@/lib/env/schema";
import { majorToMinor } from "@/lib/money";
import { DEFAULT_TEMPLATE_CONFIG } from "@/lib/catalog/default-template";
import { BUCKETS } from "@/lib/storage/buckets";
import { buildObjectKey } from "@/lib/storage/object-key";
import { parseTemplateConfig, templateConfigSchema, type TemplateConfig } from "@/types/template";

import { renderGarment } from "./seed-garments";
import {
  SEED_CATEGORIES,
  SEED_PRODUCTS,
  seedStock,
  sizeSurchargeTaka,
} from "./seed-data";

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

/** Keeps an existing template's garment images; otherwise renders and uploads fresh ones. */
async function templateConfigFor(
  db: PrismaClient,
  supabase: SupabaseClient,
  productId: string,
): Promise<TemplateConfig> {
  const existing = await db.customizationTemplate.findUnique({ where: { productId }, select: { config: true } });
  if (existing) {
    const current = parseTemplateConfig(existing.config);
    if (current.garmentImages.front && current.garmentImages.back) {
      return templateConfigSchema.parse({ ...DEFAULT_TEMPLATE_CONFIG, garmentImages: current.garmentImages });
    }
  }
  const garmentImages: TemplateConfig["garmentImages"] = {};
  for (const side of ["front", "back"] as const) {
    const key = buildObjectKey(BUCKETS.productMedia, { ownerId: productId, category: "template", extension: "webp" });
    const { error } = await supabase.storage
      .from(BUCKETS.productMedia)
      .upload(key, await renderGarment(side), { contentType: "image/webp", upsert: false });
    if (error) {
      throw new Error(`Could not upload seed garment image: ${error.name}`);
    }
    garmentImages[side] = key;
  }
  return templateConfigSchema.parse({ ...DEFAULT_TEMPLATE_CONFIG, garmentImages });
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
      select: { id: true },
    });

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
      const config = await templateConfigFor(db, supabase, product.id);
      await db.customizationTemplate.upsert({
        where: { productId: product.id },
        create: { productId: product.id, version: 1, config, aiEnabled: true, isActive: true },
        update: { config, aiEnabled: true, isActive: true },
      });
    }
  }
  log("seed.catalog", {
    categories: SEED_CATEGORIES.length,
    products: SEED_PRODUCTS.length,
    variants: variantCount,
    templates: SEED_PRODUCTS.filter((p) => p.customizable).length,
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
