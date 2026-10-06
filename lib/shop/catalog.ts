import { z } from "zod";

import { compareSizes, SIZE_ORDER } from "@/lib/catalog/size-chart";
import type { PrismaClient } from "@/lib/db/client";
import type { Prisma } from "@/lib/generated/prisma/client";
import { Size } from "@/lib/generated/prisma/enums";
import { majorToMinor } from "@/lib/money";

import { MAX_UNITS_PER_LINE } from "./limits";

// Public catalog reads. Only ACTIVE products and active variants are ever returned;
// drafts and archived items are invisible to the shop.

const firstValue = (value: unknown) => (Array.isArray(value) ? value[0] : value);
const blankToUndefined = (value: unknown) => {
  const v = firstValue(value);
  return typeof v === "string" && v.trim() === "" ? undefined : v;
};

/** Each filter is parsed independently; an invalid value is dropped instead of failing the page. */
export const productFiltersSchema = z.object({
  category: z.preprocess(blankToUndefined, z.string().regex(/^[a-z0-9-]{1,40}$/).optional()).catch(undefined),
  size: z.preprocess(blankToUndefined, z.enum(Size).optional()).catch(undefined),
  color: z.preprocess(blankToUndefined, z.string().trim().min(1).max(30).optional()).catch(undefined),
  minPrice: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).max(1_000_000).optional()).catch(undefined),
  maxPrice: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).max(1_000_000).optional()).catch(undefined),
});

export type ProductFilters = z.infer<typeof productFiltersSchema>;

export function parseProductFilters(searchParams: Record<string, string | string[] | undefined>): ProductFilters {
  return productFiltersSchema.parse(searchParams);
}

export type ColorSwatch = { name: string; hex: string };

export type ProductCard = {
  id: string;
  slug: string;
  name: string;
  categoryName: string;
  fromPriceMinor: number;
  colors: ColorSwatch[];
  customizable: boolean;
  /** Storage key of the cover photo, if the product has photos. */
  coverKey: string | null;
};

function variantWhere(filters: ProductFilters): Prisma.VariantWhereInput {
  return {
    isActive: true,
    stock: { gt: 0 },
    ...(filters.size ? { size: filters.size } : {}),
    ...(filters.color ? { colorName: { equals: filters.color, mode: "insensitive" as const } } : {}),
    ...(filters.minPrice !== undefined || filters.maxPrice !== undefined
      ? {
          priceMinor: {
            ...(filters.minPrice !== undefined ? { gte: majorToMinor(filters.minPrice) } : {}),
            ...(filters.maxPrice !== undefined ? { lte: majorToMinor(filters.maxPrice) } : {}),
          },
        }
      : {}),
  };
}

/** In-memory mirror of variantWhere(), used to compute the "from" price of matching variants. */
export function matchesFilters(
  variant: { size: Size; colorName: string; priceMinor: number; stock: number },
  filters: ProductFilters,
): boolean {
  return (
    variant.stock > 0 &&
    (!filters.size || variant.size === filters.size) &&
    (!filters.color || variant.colorName.toLowerCase() === filters.color.toLowerCase()) &&
    (filters.minPrice === undefined || variant.priceMinor >= majorToMinor(filters.minPrice)) &&
    (filters.maxPrice === undefined || variant.priceMinor <= majorToMinor(filters.maxPrice))
  );
}

function uniqueColors(variants: readonly { colorName: string; colorHex: string }[]): ColorSwatch[] {
  const seen = new Map<string, ColorSwatch>();
  for (const v of variants) {
    if (!seen.has(v.colorName)) {
      seen.set(v.colorName, { name: v.colorName, hex: v.colorHex });
    }
  }
  return [...seen.values()];
}

/** Products with at least one in-stock variant matching every filter. */
export async function listProducts(db: PrismaClient, filters: ProductFilters, limit = 48): Promise<ProductCard[]> {
  const matching = variantWhere(filters);
  const products = await db.product.findMany({
    where: {
      status: "ACTIVE",
      ...(filters.category ? { category: { slug: filters.category } } : {}),
      variants: { some: matching },
    },
    orderBy: [{ createdAt: "asc" }, { name: "asc" }],
    take: limit,
    select: {
      id: true,
      slug: true,
      name: true,
      imageKeys: true,
      category: { select: { name: true } },
      template: { select: { isActive: true } },
      variants: {
        where: { isActive: true },
        select: { colorName: true, colorHex: true, priceMinor: true, stock: true, size: true },
        orderBy: { priceMinor: "asc" },
      },
    },
  });

  return products.map((p) => {
    const matchingPrices = p.variants.filter((v) => matchesFilters(v, filters)).map((v) => v.priceMinor);
    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      categoryName: p.category.name,
      fromPriceMinor: Math.min(...matchingPrices),
      colors: uniqueColors(p.variants),
      customizable: p.template?.isActive ?? false,
      coverKey: p.imageKeys[0] ?? null,
    };
  });
}

export type FilterOptions = {
  categories: { slug: string; name: string }[];
  sizes: Size[];
  colors: ColorSwatch[];
};

export async function getFilterOptions(db: PrismaClient): Promise<FilterOptions> {
  const [categories, variants] = await Promise.all([
    db.category.findMany({
      where: { products: { some: { status: "ACTIVE" } } },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { slug: true, name: true },
    }),
    db.variant.findMany({
      where: { isActive: true, product: { status: "ACTIVE" } },
      distinct: ["colorName"],
      orderBy: { colorName: "asc" },
      select: { colorName: true, colorHex: true },
    }),
  ]);
  return { categories, sizes: [...SIZE_ORDER], colors: uniqueColors(variants) };
}

export type ProductVariantOption = {
  size: Size;
  colorName: string;
  colorHex: string;
  priceMinor: number;
  /** Units the customer may still add (capped), 0 when sold out. */
  available: number;
};

export type ProductDetail = {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: { slug: string; name: string };
  customizable: boolean;
  imageKeys: string[];
  variants: ProductVariantOption[];
};


export async function getProductBySlug(db: PrismaClient, slug: string): Promise<ProductDetail | null> {
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) {
    return null;
  }
  const product = await db.product.findFirst({
    where: { slug, status: "ACTIVE" },
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
      imageKeys: true,
      category: { select: { slug: true, name: true } },
      template: { select: { isActive: true } },
      variants: {
        where: { isActive: true },
        select: { size: true, colorName: true, colorHex: true, priceMinor: true, stock: true },
      },
    },
  });
  if (!product) {
    return null;
  }
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    description: product.description,
    category: product.category,
    customizable: product.template?.isActive ?? false,
    imageKeys: product.imageKeys,
    variants: product.variants
      .map((v) => ({
        size: v.size,
        colorName: v.colorName,
        colorHex: v.colorHex,
        priceMinor: v.priceMinor,
        available: Math.max(0, Math.min(v.stock, MAX_UNITS_PER_LINE)),
      }))
      .sort((a, b) => compareSizes(a.size, b.size) || a.colorName.localeCompare(b.colorName)),
  };
}
