import { z } from "zod";

import { assertCustomer, type Actor } from "@/lib/auth/policy";
import type { PrismaClient } from "@/lib/db/client";
import { Size } from "@/lib/generated/prisma/enums";
import { priceStoredDesign } from "@/lib/design/service";
import { lineTotalMinor } from "@/lib/money";
import { canAcceptQuote } from "@/lib/quotes/rules";
import type { StorageAdapter } from "@/lib/storage/adapter";
import { designSpecSchema } from "@/types/design-spec";

import { MAX_UNITS_PER_LINE } from "./limits";
import { ShopError } from "./errors";

// Cart operations. The client only ever names a product + size + color + quantity;
// the variant, its price and its availability are always resolved here from the database.

export const addToCartSchema = z.object({
  productId: z.uuid(),
  size: z.enum(Size),
  color: z.string().trim().min(1).max(30),
  quantity: z.coerce.number().int().min(1).max(MAX_UNITS_PER_LINE).default(1),
});

export const updateCartItemSchema = z.object({
  itemId: z.uuid(),
  quantity: z.coerce.number().int().min(0).max(MAX_UNITS_PER_LINE),
});

export const removeCartItemSchema = z.object({ itemId: z.uuid() });

export type AddToCartInput = z.input<typeof addToCartSchema>;

function maxAllowed(stock: number): number {
  return Math.max(0, Math.min(stock, MAX_UNITS_PER_LINE));
}

/** `rawInput` is untrusted (form data); Zod is the type gate. */
export async function addToCart(db: PrismaClient, actor: Actor, rawInput: unknown): Promise<void> {
  assertCustomer(actor);
  const input = addToCartSchema.parse(rawInput);

  const variant = await db.variant.findFirst({
    where: {
      productId: input.productId,
      size: input.size,
      colorName: input.color,
      isActive: true,
      product: { status: "ACTIVE" },
    },
    select: { id: true, stock: true },
  });
  if (!variant) {
    throw new ShopError("UNAVAILABLE", "That size and color isn't available.");
  }
  if (variant.stock <= 0) {
    throw new ShopError("INSUFFICIENT_STOCK", "That size and color is sold out.");
  }

  await db.$transaction(async (tx) => {
    const cart = await tx.cart.upsert({
      where: { customerId: actor.id },
      create: { customerId: actor.id },
      update: {},
      select: { id: true },
    });
    const existing = await tx.cartItem.findUnique({
      where: { cartId_variantId: { cartId: cart.id, variantId: variant.id } },
      select: { quantity: true },
    });
    const quantity = (existing?.quantity ?? 0) + input.quantity;
    const limit = maxAllowed(variant.stock);
    if (quantity > limit) {
      throw new ShopError(
        limit < MAX_UNITS_PER_LINE ? "INSUFFICIENT_STOCK" : "QUANTITY_LIMIT",
        `You can have at most ${limit} of this item in your cart.`,
      );
    }
    await tx.cartItem.upsert({
      where: { cartId_variantId: { cartId: cart.id, variantId: variant.id } },
      create: { cartId: cart.id, kind: "READY_MADE", variantId: variant.id, quantity },
      update: { quantity },
    });
  });
}

/** Finds a cart line only if it belongs to the actor's cart; otherwise behaves as "not found". */
async function findOwnedItem(db: PrismaClient, actor: Actor, itemId: string) {
  const item = await db.cartItem.findFirst({
    where: { id: itemId, cart: { customerId: actor.id } },
    select: { id: true, kind: true, variant: { select: { stock: true } } },
  });
  if (!item) {
    throw new ShopError("NOT_FOUND", "That item is no longer in your cart.");
  }
  return item;
}

export async function updateCartItem(
  db: PrismaClient,
  actor: Actor,
  rawInput: z.input<typeof updateCartItemSchema>,
): Promise<void> {
  assertCustomer(actor);
  const input = updateCartItemSchema.parse(rawInput);
  const item = await findOwnedItem(db, actor, input.itemId);

  if (input.quantity === 0) {
    await db.cartItem.delete({ where: { id: item.id } });
    return;
  }
  if (item.kind !== "READY_MADE") {
    throw new ShopError("QUANTITY_LIMIT", "Each custom design is made once. Save a copy to order another.");
  }
  const limit = maxAllowed(item.variant?.stock ?? 0);
  if (input.quantity > limit) {
    throw new ShopError("INSUFFICIENT_STOCK", `Only ${limit} available.`);
  }
  await db.cartItem.update({ where: { id: item.id }, data: { quantity: input.quantity } });
}

export async function removeCartItem(
  db: PrismaClient,
  actor: Actor,
  rawInput: z.input<typeof removeCartItemSchema>,
): Promise<void> {
  assertCustomer(actor);
  const input = removeCartItemSchema.parse(rawInput);
  const item = await findOwnedItem(db, actor, input.itemId);
  await db.cartItem.delete({ where: { id: item.id } });
}

type LineBase = {
  itemId: string;
  productName: string;
  size: Size;
  unitPriceMinor: number;
  quantity: number;
  lineTotalMinor: number;
  /** Set when the line can't be bought as-is (sold out, removed, design needs changes…). */
  issue: string | null;
};

export type ReadyMadeLine = LineBase & {
  kind: "READY_MADE";
  productSlug: string;
  colorName: string;
  colorHex: string;
};

export type CustomDesignLine = LineBase & {
  kind: "CUSTOM_DESIGN";
  designId: string;
  productId: string;
  previewKey: string | null;
};

export type QuoteLine = LineBase & {
  kind: "QUOTE";
  quoteId: string;
  productId: string;
  previewKey: string | null;
  expiresAt: string | null;
};

export type CartLine = ReadyMadeLine | CustomDesignLine | QuoteLine;

export type CartView = {
  lines: CartLine[];
  totalMinor: number;
  itemCount: number;
  canCheckout: boolean;
  hasCustomDesigns: boolean;
};

/** The actor's cart, priced from current catalog data (custom designs re-validated against their template). */
export async function getCart(db: PrismaClient, storage: StorageAdapter, actor: Actor): Promise<CartView> {
  const items = await db.cartItem.findMany({
    where: { cart: { customerId: actor.id } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      kind: true,
      quantity: true,
      variant: {
        select: {
          size: true,
          colorName: true,
          colorHex: true,
          priceMinor: true,
          stock: true,
          isActive: true,
          product: { select: { slug: true, name: true, status: true } },
        },
      },
      design: {
        select: { id: true, productId: true, spec: true, previewKey: true, product: { select: { name: true } } },
      },
      quoteRequest: {
        select: {
          id: true,
          status: true,
          priceMinor: true,
          respondBy: true,
          expiresAt: true,
          previewKey: true,
          specSnapshot: true,
          design: { select: { productId: true, product: { select: { name: true } } } },
        },
      },
    },
  });
  const now = new Date();

  const lines: CartLine[] = [];
  for (const item of items) {
    if (item.kind === "READY_MADE" && item.variant) {
      const v = item.variant;
      const available = v.isActive && v.product.status === "ACTIVE";
      let issue: string | null = null;
      if (!available) {
        issue = "No longer available";
      } else if (v.stock <= 0) {
        issue = "Sold out";
      } else if (v.stock < item.quantity) {
        issue = `Only ${v.stock} left`;
      }
      lines.push({
        kind: "READY_MADE",
        itemId: item.id,
        productSlug: v.product.slug,
        productName: v.product.name,
        size: v.size,
        colorName: v.colorName,
        colorHex: v.colorHex,
        unitPriceMinor: v.priceMinor,
        quantity: item.quantity,
        lineTotalMinor: lineTotalMinor(v.priceMinor, item.quantity),
        issue,
      });
    } else if (item.kind === "CUSTOM_DESIGN" && item.design) {
      const d = item.design;
      const check = await priceStoredDesign(db, storage, actor.id, d.spec);
      const spec = designSpecSchema.safeParse(d.spec);
      const unit = check.price?.totalMinor ?? 0;
      lines.push({
        kind: "CUSTOM_DESIGN",
        itemId: item.id,
        designId: d.id,
        productId: d.productId,
        productName: d.product.name,
        size: spec.success ? spec.data.size : "M",
        previewKey: d.previewKey,
        unitPriceMinor: unit,
        quantity: 1,
        lineTotalMinor: unit,
        issue: check.issue,
      });
    }
  }

  for (const item of items) {
    if (item.kind !== "QUOTE" || !item.quoteRequest) continue;
    const q = item.quoteRequest;
    const spec = designSpecSchema.safeParse(q.specSnapshot);
    const unit = q.priceMinor ?? 0;
    lines.push({
      kind: "QUOTE",
      itemId: item.id,
      quoteId: q.id,
      productId: q.design.productId,
      productName: q.design.product.name,
      size: spec.success ? spec.data.size : "M",
      previewKey: q.previewKey,
      expiresAt: q.expiresAt?.toISOString() ?? null,
      unitPriceMinor: unit,
      quantity: 1,
      lineTotalMinor: unit,
      issue: canAcceptQuote(q, now) && q.priceMinor !== null ? null : "This quote has expired or was closed",
    });
  }

  const payable = lines.filter((l) => l.issue === null);
  const hasCustomDesigns = lines.some((l) => l.kind === "CUSTOM_DESIGN");
  return {
    lines,
    totalMinor: payable.reduce((sum, l) => sum + l.lineTotalMinor, 0),
    itemCount: lines.reduce((sum, l) => sum + l.quantity, 0),
    canCheckout: lines.length > 0 && payable.length === lines.length,
    hasCustomDesigns,
  };
}

export async function getCartCount(db: PrismaClient, customerId: string): Promise<number> {
  const result = await db.cartItem.aggregate({
    where: { cart: { customerId } },
    _sum: { quantity: true },
  });
  return result._sum.quantity ?? 0;
}
