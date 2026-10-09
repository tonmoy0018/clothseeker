import type { DesignStartedFrom, DesignStatus, QuoteStatus } from "@/lib/generated/prisma/enums";

// Pure quote rules (unit tested). Quotes are for designs started from a customer's dress photo
// that may need special tailoring. The team replies within 24 hours; a price is valid for 7 days
// (decided 2026-10-09). After payment the item starts at ACCEPTED (lib/orders/transitions.ts).

export const QUOTE_RESPONSE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const QUOTE_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;
/** Open quote requests a customer may have at once (keeps the team's queue sane). */
export const MAX_OPEN_QUOTES = 5;
export const MAX_QUOTE_PRICE_MINOR = 10_000_000; // ৳100,000

export const OPEN_QUOTE_STATUSES = ["REQUESTED", "QUOTED"] as const satisfies readonly QuoteStatus[];

export type QuoteEligibilityInput = {
  design: { status: DesignStatus; startedFrom: DesignStartedFrom; referencePhotoKey: string | null };
  /** Quotes already open (REQUESTED/QUOTED) for this design. */
  openQuotesForDesign: number;
  /** All the customer's open quotes. */
  openQuotesForCustomer: number;
};

/** Null when a quote may be requested, otherwise the reason it can't (shown to the customer). */
export function quoteIneligibility(input: QuoteEligibilityInput): string | null {
  if (input.design.startedFrom !== "PHOTO" || !input.design.referencePhotoKey) {
    return "Tailoring quotes are for designs started from a photo of a dress.";
  }
  if (input.design.status !== "SAVED") {
    return "Save your design first, then request a quote.";
  }
  if (input.openQuotesForDesign > 0) {
    return "You already have an open quote for this design.";
  }
  if (input.openQuotesForCustomer >= MAX_OPEN_QUOTES) {
    return `You can have up to ${MAX_OPEN_QUOTES} open quote requests at a time.`;
  }
  return null;
}

export type QuoteTimes = { status: QuoteStatus; respondBy: Date; expiresAt: Date | null };

/** The status as of `now`, even before the expiry sweep has run. */
export function effectiveQuoteStatus(quote: QuoteTimes, now: Date): QuoteStatus {
  if (quote.status === "REQUESTED" && quote.respondBy.getTime() <= now.getTime()) {
    return "EXPIRED";
  }
  if (quote.status === "QUOTED" && quote.expiresAt && quote.expiresAt.getTime() <= now.getTime()) {
    return "EXPIRED";
  }
  return quote.status;
}

/** A quoted price can be accepted (added to the cart) and paid. */
export function canAcceptQuote(quote: QuoteTimes, now: Date): boolean {
  return effectiveQuoteStatus(quote, now) === "QUOTED";
}

export const QUOTE_STATUS_LABEL: Record<QuoteStatus, string> = {
  REQUESTED: "Waiting for our reply",
  QUOTED: "Price ready",
  DECLINED: "Declined",
  ACCEPTED: "Ordered",
  EXPIRED: "Expired",
  WITHDRAWN: "Withdrawn",
};
