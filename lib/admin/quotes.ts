import { z } from "zod";

import { assertAdmin, type Actor } from "@/lib/auth/policy";
import type { PrismaClient } from "@/lib/db/client";
import type { Prisma } from "@/lib/generated/prisma/client";
import { majorToMinor } from "@/lib/money";
import { effectiveQuoteStatus, MAX_QUOTE_PRICE_MINOR, QUOTE_VALIDITY_MS } from "@/lib/quotes/rules";
import { toQuoteViews, type QuoteView } from "@/lib/quotes/service";
import type { StorageAdapter } from "@/lib/storage/adapter";
import { parseDesignSpec, type DesignSpec } from "@/types/design-spec";

import { writeAudit } from "./audit";
import { AdminError } from "./errors";

// The team's side of tailoring quotes: a queue, the details needed to price the work (design,
// reference photo, notes — no customer contact data), and replying with a price or a decline.

export const QUOTE_TABS = {
  needs_reply: { label: "Needs reply" },
  quoted: { label: "Quoted" },
  closed: { label: "Closed" },
} as const;
export type QuoteTab = keyof typeof QUOTE_TABS;
export const QUOTE_TAB_IDS = ["needs_reply", "quoted", "closed"] as const satisfies readonly QuoteTab[];

const select = {
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

function tabWhere(tab: QuoteTab, now: Date): Prisma.QuoteRequestWhereInput {
  switch (tab) {
    case "needs_reply":
      return { status: "REQUESTED", respondBy: { gt: now } };
    case "quoted":
      return { status: "QUOTED", expiresAt: { gt: now } };
    case "closed":
      return { NOT: { OR: [{ status: "REQUESTED", respondBy: { gt: now } }, { status: "QUOTED", expiresAt: { gt: now } }] } };
  }
}

export async function listQuotesForAdmin(db: PrismaClient, storage: StorageAdapter, actor: Actor, rawTab: unknown, now: Date = new Date()): Promise<QuoteView[]> {
  assertAdmin(actor);
  const tab = z.enum(QUOTE_TAB_IDS).catch("needs_reply").parse(rawTab);
  const rows = await db.quoteRequest.findMany({
    where: tabWhere(tab, now),
    // Oldest deadline first, so nothing is missed.
    orderBy: tab === "needs_reply" ? [{ respondBy: "asc" }] : [{ updatedAt: "desc" }],
    take: 100,
    select,
  });
  return toQuoteViews(storage, rows, now);
}

export async function countQuotesNeedingReply(db: PrismaClient, actor: Actor, now: Date = new Date()): Promise<number> {
  assertAdmin(actor);
  return db.quoteRequest.count({ where: tabWhere("needs_reply", now) });
}

export type AdminQuote = QuoteView & { spec: DesignSpec | null };

export async function getQuoteForAdmin(db: PrismaClient, storage: StorageAdapter, actor: Actor, rawId: unknown, now: Date = new Date()): Promise<AdminQuote | null> {
  assertAdmin(actor);
  const id = z.uuid().safeParse(rawId);
  const row = id.success ? await db.quoteRequest.findUnique({ where: { id: id.data }, select }) : null;
  if (!row) {
    return null;
  }
  const [view] = await toQuoteViews(storage, [row], now);
  let spec: DesignSpec | null = null;
  try {
    spec = parseDesignSpec(row.specSnapshot);
  } catch {
    spec = null;
  }
  return view ? { ...view, spec } : null;
}

const note = z.string().trim().max(1000, "Keep the note under 1000 characters.");

export const respondToQuoteSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("price"),
    quoteId: z.uuid(),
    priceTaka: z.coerce
      .number({ error: "Enter a price" })
      .positive("The price must be more than ৳0")
      .refine((v) => majorToMinor(v) <= MAX_QUOTE_PRICE_MINOR, "That price is too high")
      .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, "Use at most 2 decimal places"),
    note: note.min(5, "Tell the customer what the price includes."),
  }),
  z.object({ action: z.literal("decline"), quoteId: z.uuid(), note: note.min(5, "Tell the customer why we can't make it.") }),
]);

/** Sends a price (valid for 7 days) or declines. Only while the request is open; audited. */
export async function respondToQuote(db: PrismaClient, actor: Actor, rawInput: unknown, now: Date = new Date()): Promise<void> {
  assertAdmin(actor);
  const parsed = respondToQuoteSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AdminError("INVALID", parsed.error.issues[0]?.message ?? "Please check the form.");
  }
  const input = parsed.data;
  const quote = await db.quoteRequest.findUnique({ where: { id: input.quoteId }, select: { id: true, status: true, respondBy: true, expiresAt: true } });
  if (!quote) {
    throw new AdminError("NOT_FOUND", "That quote request doesn't exist.");
  }
  if (effectiveQuoteStatus(quote, now) !== "REQUESTED") {
    throw new AdminError("CONFLICT", "This request is no longer waiting for a reply.");
  }
  await db.$transaction(async (tx) => {
    const data =
      input.action === "price"
        ? { status: "QUOTED" as const, priceMinor: majorToMinor(input.priceTaka), responseNote: input.note, respondedAt: now, expiresAt: new Date(now.getTime() + QUOTE_VALIDITY_MS) }
        : { status: "DECLINED" as const, responseNote: input.note, respondedAt: now };
    const updated = await tx.quoteRequest.updateMany({ where: { id: quote.id, status: "REQUESTED", respondBy: { gt: now } }, data });
    if (updated.count !== 1) {
      throw new AdminError("CONFLICT", "This request is no longer waiting for a reply.");
    }
    await writeAudit(
      tx,
      actor,
      input.action === "price" ? "quote.priced" : "quote.declined",
      { type: "quote_request", id: quote.id },
      input.action === "price" ? { priceMinor: majorToMinor(input.priceTaka) } : {},
    );
  });
}
