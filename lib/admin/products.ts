import { z } from "zod";

import { assertAdmin, type Actor } from "@/lib/auth/policy";
import { compareSizes } from "@/lib/catalog/size-chart";
import type { PrismaClient } from "@/lib/db/client";
import { Prisma } from "@/lib/generated/prisma/client";
import { ProductStatus, type Size } from "@/lib/generated/prisma/enums";
import { slugify } from "@/lib/text/slug";

import { changedFields, writeAudit } from "./audit";
import { AdminError } from "./errors";

// Catalog management for the ClothSeeker team. Every function requires an admin actor.

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Use at least 3 characters")
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single hyphens");

const productFields = {
  name: z.string().trim().min(2, "Enter a name").max(80),
  categoryId: z.uuid("Choose a category"),
  description: z.string().trim().min(10, "Write at least a sentence").max(2000),
};

export const createProductSchema = z.object({
  ...productFields,
  slug: z.preprocess((v) => (v === "" ? undefined : v), slugSchema.optional()),
});

export const updateProductSchema = z.object({ id: z.uuid(), ...productFields, slug: slugSchema });

export const setProductStatusSchema = z.object({ id: z.uuid(), status: z.enum(ProductStatus) });

async function ensureCategory(db: PrismaClient, categoryId: string): Promise<void> {
  const exists = await db.category.count({ where: { id: categoryId } });
  if (exists === 0) {
    throw new AdminError("INVALID", "That category doesn't exist.");
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function createProduct(db: PrismaClient, actor: Actor, rawInput: unknown): Promise<{ id: string }> {
  assertAdmin(actor);
  const input = createProductSchema.parse(rawInput);
  await ensureCategory(db, input.categoryId);
  const slug = input.slug ?? slugSchema.parse(slugify(input.name));

  try {
    return await db.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: { name: input.name, slug, categoryId: input.categoryId, description: input.description, status: "DRAFT" },
        select: { id: true },
      });
      await writeAudit(tx, actor, "product.create", { type: "product", id: product.id }, { slug });
      return product;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AdminError("CONFLICT", `The web address "${slug}" is already used by another dress.`);
    }
    throw error;
  }
}

export async function updateProduct(db: PrismaClient, actor: Actor, rawInput: unknown): Promise<void> {
  assertAdmin(actor);
  const input = updateProductSchema.parse(rawInput);
  const before = await db.product.findUnique({
    where: { id: input.id },
    select: { name: true, slug: true, categoryId: true, description: true },
  });
  if (!before) {
    throw new AdminError("NOT_FOUND", "That dress no longer exists.");
  }
  await ensureCategory(db, input.categoryId);
  const after = { name: input.name, slug: input.slug, categoryId: input.categoryId, description: input.description };
  const fields = changedFields(before, after);
  if (fields.length === 0) {
    return;
  }

  try {
    await db.$transaction(async (tx) => {
      await tx.product.update({ where: { id: input.id }, data: after });
      await writeAudit(tx, actor, "product.update", { type: "product", id: input.id }, { fields });
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AdminError("CONFLICT", `The web address "${input.slug}" is already used by another dress.`);
    }
    throw error;
  }
}

/** Publishing needs at least one active variant with a price; drafts and archived items are hidden from the shop. */
export async function setProductStatus(db: PrismaClient, actor: Actor, rawInput: unknown): Promise<void> {
  assertAdmin(actor);
  const input = setProductStatusSchema.parse(rawInput);
  const product = await db.product.findUnique({ where: { id: input.id }, select: { status: true } });
  if (!product) {
    throw new AdminError("NOT_FOUND", "That dress no longer exists.");
  }
  if (product.status === input.status) {
    return;
  }
  if (input.status === "ACTIVE") {
    const sellable = await db.variant.count({ where: { productId: input.id, isActive: true, priceMinor: { gt: 0 } } });
    if (sellable === 0) {
      throw new AdminError("BLOCKED", "Add at least one active size/color with a price before publishing.");
    }
  }
  await db.$transaction(async (tx) => {
    await tx.product.update({ where: { id: input.id }, data: { status: input.status } });
    await writeAudit(tx, actor, "product.status", { type: "product", id: input.id }, {
      from: product.status,
      to: input.status,
    });
  });
}

export const adminProductFiltersSchema = z.object({
  status: z.enum(ProductStatus).optional().catch(undefined),
  categoryId: z.uuid().optional().catch(undefined),
  q: z.string().trim().max(80).optional().catch(undefined),
});

export type AdminProductRow = {
  id: string;
  slug: string;
  name: string;
  status: ProductStatus;
  categoryName: string;
  variantCount: number;
  activeVariantCount: number;
  totalStock: number;
  photoCount: number;
  coverKey: string | null;
  template: { isActive: boolean } | null;
  updatedAt: Date;
};

export async function listAdminProducts(db: PrismaClient, actor: Actor, rawFilters: unknown): Promise<AdminProductRow[]> {
  assertAdmin(actor);
  const filters = adminProductFiltersSchema.parse(rawFilters ?? {});
  const products = await db.product.findMany({
    where: {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
      ...(filters.q
        ? {
            OR: [
              { name: { contains: filters.q, mode: "insensitive" as const } },
              { slug: { contains: filters.q.toLowerCase() } },
            ],
          }
        : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: 200,
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      imageKeys: true,
      updatedAt: true,
      category: { select: { name: true } },
      template: { select: { isActive: true } },
      variants: { select: { isActive: true, stock: true } },
    },
  });
  return products.map((p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    status: p.status,
    categoryName: p.category.name,
    variantCount: p.variants.length,
    activeVariantCount: p.variants.filter((v) => v.isActive).length,
    totalStock: p.variants.filter((v) => v.isActive).reduce((sum, v) => sum + v.stock, 0),
    photoCount: p.imageKeys.length,
    coverKey: p.imageKeys[0] ?? null,
    template: p.template,
    updatedAt: p.updatedAt,
  }));
}

export type AdminVariant = {
  id: string;
  sku: string;
  size: Size;
  colorName: string;
  colorHex: string;
  priceMinor: number;
  stock: number;
  isActive: boolean;
};

export type AdminProduct = {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: ProductStatus;
  categoryId: string;
  imageKeys: string[];
  variants: AdminVariant[];
  template: { isActive: boolean; version: number; aiEnabled: boolean } | null;
};

export async function getAdminProduct(db: PrismaClient, actor: Actor, productId: string): Promise<AdminProduct | null> {
  assertAdmin(actor);
  if (!z.uuid().safeParse(productId).success) {
    return null;
  }
  const product = await db.product.findUnique({
    where: { id: productId },
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
      status: true,
      categoryId: true,
      imageKeys: true,
      template: { select: { isActive: true, version: true, aiEnabled: true } },
      variants: {
        select: {
          id: true,
          sku: true,
          size: true,
          colorName: true,
          colorHex: true,
          priceMinor: true,
          stock: true,
          isActive: true,
        },
      },
    },
  });
  if (!product) {
    return null;
  }
  return {
    ...product,
    variants: [...product.variants].sort(
      (a, b) => a.colorName.localeCompare(b.colorName) || compareSizes(a.size, b.size),
    ),
  };
}

export async function listCategories(db: PrismaClient, actor: Actor) {
  assertAdmin(actor);
  return db.category.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true } });
}

export type AdminDashboard = {
  counts: Record<ProductStatus, number>;
  lowStock: { productId: string; productName: string; size: Size; colorName: string; stock: number }[];
  inactiveTemplates: number;
};

export const LOW_STOCK_THRESHOLD = 2;

export async function getAdminDashboard(db: PrismaClient, actor: Actor): Promise<AdminDashboard> {
  assertAdmin(actor);
  const [grouped, lowStock, inactiveTemplates] = await Promise.all([
    db.product.groupBy({ by: ["status"], _count: { _all: true } }),
    db.variant.findMany({
      where: { isActive: true, stock: { lte: LOW_STOCK_THRESHOLD }, product: { status: "ACTIVE" } },
      orderBy: [{ stock: "asc" }, { updatedAt: "desc" }],
      take: 12,
      select: { size: true, colorName: true, stock: true, product: { select: { id: true, name: true } } },
    }),
    db.customizationTemplate.count({ where: { isActive: false } }),
  ]);
  const counts: Record<ProductStatus, number> = { DRAFT: 0, ACTIVE: 0, ARCHIVED: 0 };
  for (const row of grouped) {
    counts[row.status] = row._count._all;
  }
  return {
    counts,
    lowStock: lowStock.map((v) => ({
      productId: v.product.id,
      productName: v.product.name,
      size: v.size,
      colorName: v.colorName,
      stock: v.stock,
    })),
    inactiveTemplates,
  };
}
