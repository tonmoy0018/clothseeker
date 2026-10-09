import { z } from "zod";

import { assertCustomer, type Actor } from "@/lib/auth/policy";
import type { PrismaClient } from "@/lib/db/client";
import { normalizeForRender } from "@/lib/design/normalize";
import { checkDesign, DesignError } from "@/lib/design/service";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { QuoteStatus } from "@/lib/generated/prisma/enums";
import { renderPreview, storageAssets } from "@/lib/renderer/render";
import type { StorageAdapter } from "@/lib/storage/adapter";
import { BUCKETS } from "@/lib/storage/buckets";
import { buildObjectKey, isSafeObjectKey } from "@/lib/storage/object-key";
import { parseDesignSpec } from "@/types/design-spec";

import { canAcceptQuote, effectiveQuoteStatus, OPEN_QUOTE_STATUSES, QUOTE_RESPONSE_WINDOW_MS, quoteIneligibility } from "./rules";

// Customer side of tailoring quotes: request one for a photo-started design, see replies, accept a
// price (adds it to the cart at the quoted price) or withdraw. All queries are owner-scoped.

export type QuoteErrorCode = "INVALID" | "NOT_FOUND" | "NOT_ELIGIBLE" | "EXPIRED";

export class QuoteError extends Error {
  override readonly name = "QuoteError";

  constructor(
    readonly code: QuoteErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Quotes still open as of `now` (awaiting a reply in time, or priced and not expired). */
export function openQuoteWhere(now: Date): Prisma.QuoteRequestWhereInput {
  return { OR: [{ status: "REQUESTED", respondBy: { gt: now } }, { status: "QUOTED", expiresAt: { gt: now } }] };
}

const requestSchema = z.object({
  designId: z.uuid(),
  notes: z
    .string()
    .trim()
    .min(10, "Tell the tailors what needs special attention (at least a few words).")
    .max(1000, "Keep your notes under 1000 characters."),
});

/** Asks the team for a price. Freezes the design (spec + its own preview) for the quote. */
export async function requestQuote(
  db: PrismaClient,
  storage: StorageAdapter,
  actor: Actor,
  rawInput: unknown,
  now: Date = new Date(),
): Promise<{ quoteId: string }> {
  assertCustomer(actor);
  const parsed = requestSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new QuoteError("INVALID", parsed.error.issues[0]?.message ?? "Please check your request.");
  }
  const input = parsed.data;
  const design = await db.design.findFirst({
    where: { id: input.designId, customerId: actor.id },
    select: { id: true, status: true, startedFrom: true, referencePhotoKey: true, spec: true },
  });
  if (!design) {
    throw new QuoteError("NOT_FOUND", "That design doesn't exist or isn't yours.");
  }

  let checked;
  try {
    checked = await checkDesign(db, storage, actor.id, design.spec);
  } catch (error) {
    if (error instanceof DesignError) {
      throw new QuoteError("NOT_ELIGIBLE", "This design needs changes before it can be quoted. Open it and save it again.");
    }
    throw error;
  }

  // Render the snapshot's preview before the transaction (slow; no locks held).
  const previewKey = buildObjectKey(BUCKETS.designAssets, { ownerId: actor.id, category: "quotes", extension: "png" });
  await storage.put(BUCKETS.designAssets, previewKey, await renderPreview(normalizeForRender(checked.spec, checked.context.template.config), "front", storageAssets(storage)), "image/png");

  try {
    return await db.$transaction(async (tx) => {
      // One request at a time per customer, so the open-quote limit holds under double clicks.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`quotes:${actor.id}`}, 0))`;
      const [openForDesign, openForCustomer] = await Promise.all([
        tx.quoteRequest.count({ where: { designId: design.id, ...openQuoteWhere(now) } }),
        tx.quoteRequest.count({ where: { customerId: actor.id, ...openQuoteWhere(now) } }),
      ]);
      const problem = quoteIneligibility({ design, openQuotesForDesign: openForDesign, openQuotesForCustomer: openForCustomer });
      if (problem) {
        throw new QuoteError("NOT_ELIGIBLE", problem);
      }
      const quote = await tx.quoteRequest.create({
        data: {
          customerId: actor.id,
          designId: design.id,
          notes: input.notes,
          specSnapshot: checked.spec,
          previewKey,
          referencePhotoKey: design.referencePhotoKey,
          respondBy: new Date(now.getTime() + QUOTE_RESPONSE_WINDOW_MS),
          createdAt: now,
        },
        select: { id: true },
      });
      return { quoteId: quote.id };
    });
  } catch (error) {
    await storage.remove(BUCKETS.designAssets, [previewKey]).catch(() => undefined);
    throw error;
  }
}

export type QuoteView = {
  id: string;
  designId: string;
  productId: string;
  productName: string;
  size: string;
  notes: string;
  status: QuoteStatus;
  priceMinor: number | null;
  responseNote: string | null;
  respondBy: string;
  expiresAt: string | null;
  createdAt: string;
  previewUrl: string | null;
  referencePhotoUrl: string | null;
  inCart: boolean;
};

const quoteSelect = {
  id: true,
  designId: true,
  notes: true,
  status: true,
  priceMinor: true,
  responseNote: true,
  respondBy: true,
  expiresAt: true,
  createdAt: true,
  previewKey: true,
  referencePhotoKey: true,
  specSnapshot: true,
  design: { select: { productId: true, product: { select: { name: true } } } },
  cartItems: { select: { id: true } },
} as const;

type QuoteRow = {
  id: string;
  designId: string;
  notes: string;
  status: QuoteStatus;
  priceMinor: number | null;
  responseNote: string | null;
  respondBy: Date;
  expiresAt: Date | null;
  createdAt: Date;
  previewKey: string | null;
  referencePhotoKey: string | null;
  specSnapshot: unknown;
  design: { productId: string; product: { name: string } };
  cartItems: { id: string }[];
};

/** Quote rows → views with signed image URLs and the status as of `now`. */
export async function toQuoteViews(storage: StorageAdapter, rows: QuoteRow[], now: Date): Promise<QuoteView[]> {
  const keys = rows.flatMap((r) => [r.previewKey, r.referencePhotoKey]).filter((k): k is string => typeof k === "string" && isSafeObjectKey(k));
  const urls = await storage.signReadUrls(BUCKETS.designAssets, keys);
  return rows.map((r) => {
    let size = "";
    try {
      size = parseDesignSpec(r.specSnapshot).size;
    } catch {
      // Unreadable snapshot: shown without a size.
    }
    return {
      id: r.id,
      designId: r.designId,
      productId: r.design.productId,
      productName: r.design.product.name,
      size,
      notes: r.notes,
      status: effectiveQuoteStatus(r, now),
      priceMinor: r.priceMinor,
      responseNote: r.responseNote,
      respondBy: r.respondBy.toISOString(),
      expiresAt: r.expiresAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      previewUrl: r.previewKey ? (urls.get(r.previewKey) ?? null) : null,
      referencePhotoUrl: r.referencePhotoKey ? (urls.get(r.referencePhotoKey) ?? null) : null,
      inCart: r.cartItems.length > 0,
    };
  });
}

export async function listMyQuotes(db: PrismaClient, storage: StorageAdapter, actor: Actor, now: Date = new Date()): Promise<QuoteView[]> {
  const rows = await db.quoteRequest.findMany({ where: { customerId: actor.id }, orderBy: { createdAt: "desc" }, take: 50, select: quoteSelect });
  return toQuoteViews(storage, rows, now);
}

export async function getMyQuote(db: PrismaClient, storage: StorageAdapter, actor: Actor, rawId: unknown, now: Date = new Date()): Promise<QuoteView | null> {
  const id = z.uuid().safeParse(rawId);
  if (!id.success) {
    return null;
  }
  const row = await db.quoteRequest.findFirst({ where: { id: id.data, customerId: actor.id }, select: quoteSelect });
  if (!row) {
    return null;
  }
  const [view] = await toQuoteViews(storage, [row], now);
  return view ?? null;
}

async function ownQuote(db: PrismaClient, actor: Actor, rawId: unknown) {
  const id = z.uuid().safeParse(rawId);
  const quote = id.success
    ? await db.quoteRequest.findFirst({ where: { id: id.data, customerId: actor.id }, select: { id: true, status: true, respondBy: true, expiresAt: true } })
    : null;
  if (!quote) {
    throw new QuoteError("NOT_FOUND", "That quote doesn't exist.");
  }
  return quote;
}

/** Adds a quoted price to the cart (once). The price always comes from the quote, never the client. */
export async function acceptQuote(db: PrismaClient, actor: Actor, rawId: unknown, now: Date = new Date()): Promise<void> {
  assertCustomer(actor);
  const quote = await ownQuote(db, actor, rawId);
  if (!canAcceptQuote(quote, now)) {
    throw new QuoteError(effectiveQuoteStatus(quote, now) === "EXPIRED" ? "EXPIRED" : "NOT_ELIGIBLE", "This quote can't be accepted any more.");
  }
  await db.$transaction(async (tx) => {
    const cart = await tx.cart.upsert({ where: { customerId: actor.id }, create: { customerId: actor.id }, update: {}, select: { id: true } });
    const already = await tx.cartItem.count({ where: { cartId: cart.id, quoteRequestId: quote.id } });
    if (already === 0) {
      await tx.cartItem.create({ data: { cartId: cart.id, kind: "QUOTE", quoteRequestId: quote.id, quantity: 1 } });
    }
  });
}

/** The customer closes a request or a price they don't want. */
export async function withdrawQuote(db: PrismaClient, actor: Actor, rawId: unknown, now: Date = new Date()): Promise<void> {
  assertCustomer(actor);
  const quote = await ownQuote(db, actor, rawId);
  const status = effectiveQuoteStatus(quote, now);
  if (status !== "REQUESTED" && status !== "QUOTED") {
    throw new QuoteError("NOT_ELIGIBLE", "This quote is already closed.");
  }
  await db.$transaction(async (tx) => {
    const updated = await tx.quoteRequest.updateMany({ where: { id: quote.id, status: { in: [...OPEN_QUOTE_STATUSES] } }, data: { status: "WITHDRAWN" } });
    if (updated.count !== 1) {
      throw new QuoteError("NOT_ELIGIBLE", "This quote is already closed.");
    }
    await tx.cartItem.deleteMany({ where: { quoteRequestId: quote.id } });
  });
}

/**
 * Worker sweep: no reply within 24 hours → EXPIRED; a price not paid within 7 days → EXPIRED (and
 * its cart line removed). Idempotent.
 */
export async function expireQuotes(db: PrismaClient, now: Date = new Date()): Promise<number> {
  return db.$transaction(async (tx) => {
    const unanswered = await tx.quoteRequest.updateMany({ where: { status: "REQUESTED", respondBy: { lte: now } }, data: { status: "EXPIRED" } });
    const stale = await tx.quoteRequest.findMany({ where: { status: "QUOTED", expiresAt: { lte: now } }, select: { id: true } });
    if (stale.length > 0) {
      const ids = stale.map((q) => q.id);
      await tx.quoteRequest.updateMany({ where: { id: { in: ids }, status: "QUOTED" }, data: { status: "EXPIRED" } });
      await tx.cartItem.deleteMany({ where: { quoteRequestId: { in: ids } } });
    }
    return unanswered.count + stale.length;
  });
}
