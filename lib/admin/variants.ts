import { randomInt } from "node:crypto";

import { z } from "zod";

import { assertAdmin, type Actor } from "@/lib/auth/policy";
import type { PrismaClient } from "@/lib/db/client";
import { Prisma } from "@/lib/generated/prisma/client";
import { Size } from "@/lib/generated/prisma/enums";
import { majorToMinor } from "@/lib/money";

import { changedFields, writeAudit } from "./audit";
import { AdminError } from "./errors";

// Size/color variants. Variants are never hard-deleted (order history references them);
// deactivate instead, which hides them from the shop immediately.

const priceTaka = z.coerce
  .number({ error: "Enter a price" })
  .positive("Price must be more than ৳0")
  .max(1_000_000, "That price is too high")
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, { message: "Use at most 2 decimal places" });
const stock = z.coerce.number({ error: "Enter stock" }).int("Stock must be a whole number").min(0).max(100_000);

export const addVariantSchema = z.object({
  productId: z.uuid(),
  size: z.enum(Size, { error: "Choose a size" }),
  colorName: z
    .string()
    .trim()
    .min(1, "Enter a color name")
    .max(30)
    .regex(/^[A-Za-z][A-Za-z ]*$/, "Use letters and spaces only"),
  colorHex: z.string().regex(/^#[0-9a-f]{6}$/i, "Pick a color"),
  priceTaka,
  stock,
});

export const updateVariantSchema = z.object({
  variantId: z.uuid(),
  priceTaka,
  stock,
  isActive: z.preprocess((v) => v === true || v === "on" || v === "true", z.boolean()),
});

/** e.g. ("linen-wrap-dress", "M", "Ink Navy") → "LINEN-WRAP-DRESS-M-INKNAVY" (max 48 chars). */
export function generateSku(productSlug: string, size: Size, colorName: string): string {
  const base = productSlug.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 24);
  const color = colorName.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
  return `${base}-${size}-${color}`;
}

function titleCase(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export async function addVariant(db: PrismaClient, actor: Actor, rawInput: unknown): Promise<{ id: string }> {
  assertAdmin(actor);
  const input = addVariantSchema.parse(rawInput);
  const product = await db.product.findUnique({ where: { id: input.productId }, select: { slug: true } });
  if (!product) {
    throw new AdminError("NOT_FOUND", "That dress no longer exists.");
  }
  const colorName = titleCase(input.colorName);
  const duplicate = await db.variant.count({
    where: { productId: input.productId, size: input.size, colorName: { equals: colorName, mode: "insensitive" } },
  });
  if (duplicate > 0) {
    throw new AdminError("CONFLICT", `Size ${input.size} in ${colorName} already exists. Edit that row instead.`);
  }

  let sku = generateSku(product.slug, input.size, colorName);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        const variant = await tx.variant.create({
          data: {
            productId: input.productId,
            sku,
            size: input.size,
            colorName,
            colorHex: input.colorHex.toLowerCase(),
            priceMinor: majorToMinor(input.priceTaka),
            stock: input.stock,
            isActive: true,
          },
          select: { id: true },
        });
        await writeAudit(tx, actor, "variant.create", { type: "variant", id: variant.id }, {
          productId: input.productId,
          sku,
        });
        return variant;
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
        throw error;
      }
      // SKU taken (e.g. a renamed product reused a slug): add a short random suffix and retry.
      sku = `${generateSku(product.slug, input.size, colorName)}-${randomInt(1000, 10_000)}`;
    }
  }
  throw new AdminError("CONFLICT", "Couldn't create a unique SKU. Please try again.");
}

export async function updateVariant(db: PrismaClient, actor: Actor, rawInput: unknown): Promise<void> {
  assertAdmin(actor);
  const input = updateVariantSchema.parse(rawInput);
  const before = await db.variant.findUnique({
    where: { id: input.variantId },
    select: { priceMinor: true, stock: true, isActive: true, productId: true },
  });
  if (!before) {
    throw new AdminError("NOT_FOUND", "That size/color no longer exists.");
  }
  const after = { priceMinor: majorToMinor(input.priceTaka), stock: input.stock, isActive: input.isActive };
  const fields = changedFields(before, after);
  if (fields.length === 0) {
    return;
  }
  await db.$transaction(async (tx) => {
    await tx.variant.update({ where: { id: input.variantId }, data: after });
    await writeAudit(tx, actor, "variant.update", { type: "variant", id: input.variantId }, {
      productId: before.productId,
      fields,
    });
  });
}
