import { describe, expect, it } from "vitest";

import { canTransition, HAPPY_PATH } from "@/lib/orders/transitions";
import { canAcceptQuote, effectiveQuoteStatus, MAX_OPEN_QUOTES, QUOTE_RESPONSE_WINDOW_MS, QUOTE_VALIDITY_MS, quoteIneligibility } from "@/lib/quotes/rules";

const savedPhotoDesign = { status: "SAVED", startedFrom: "PHOTO", referencePhotoKey: "c/references/x.webp" } as const;

describe("quote eligibility", () => {
  it("only saved designs started from a dress photo, one open quote per design", () => {
    expect(quoteIneligibility({ design: savedPhotoDesign, openQuotesForDesign: 0, openQuotesForCustomer: 0 })).toBeNull();
    expect(quoteIneligibility({ design: { ...savedPhotoDesign, startedFrom: "SHOP" }, openQuotesForDesign: 0, openQuotesForCustomer: 0 })).toMatch(/started from a photo/);
    expect(quoteIneligibility({ design: { ...savedPhotoDesign, startedFrom: "DESCRIPTION" }, openQuotesForDesign: 0, openQuotesForCustomer: 0 })).toMatch(/started from a photo/);
    expect(quoteIneligibility({ design: { ...savedPhotoDesign, referencePhotoKey: null }, openQuotesForDesign: 0, openQuotesForCustomer: 0 })).toMatch(/started from a photo/);
    expect(quoteIneligibility({ design: { ...savedPhotoDesign, status: "DRAFT" }, openQuotesForDesign: 0, openQuotesForCustomer: 0 })).toMatch(/Save your design/);
    expect(quoteIneligibility({ design: { ...savedPhotoDesign, status: "ORDERED" }, openQuotesForDesign: 0, openQuotesForCustomer: 0 })).toMatch(/Save your design/);
    expect(quoteIneligibility({ design: savedPhotoDesign, openQuotesForDesign: 1, openQuotesForCustomer: 1 })).toMatch(/already have an open quote/);
    expect(quoteIneligibility({ design: savedPhotoDesign, openQuotesForDesign: 0, openQuotesForCustomer: MAX_OPEN_QUOTES })).toMatch(/up to 5/);
  });
});

describe("quote expiry", () => {
  const t0 = new Date("2026-10-09T09:00:00Z");
  const respondBy = new Date(t0.getTime() + QUOTE_RESPONSE_WINDOW_MS);

  it("the team has 24 hours to reply", () => {
    expect(QUOTE_RESPONSE_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    const quote = { status: "REQUESTED" as const, respondBy, expiresAt: null };
    expect(effectiveQuoteStatus(quote, new Date(respondBy.getTime() - 1))).toBe("REQUESTED");
    expect(effectiveQuoteStatus(quote, respondBy)).toBe("EXPIRED");
  });

  it("a price is valid for 7 days", () => {
    expect(QUOTE_VALIDITY_MS).toBe(7 * 24 * 60 * 60 * 1000);
    const expiresAt = new Date(t0.getTime() + QUOTE_VALIDITY_MS);
    const quote = { status: "QUOTED" as const, respondBy, expiresAt };
    expect(canAcceptQuote(quote, new Date(expiresAt.getTime() - 1))).toBe(true);
    expect(canAcceptQuote(quote, expiresAt)).toBe(false);
    expect(effectiveQuoteStatus(quote, expiresAt)).toBe("EXPIRED");
    for (const status of ["REQUESTED", "DECLINED", "ACCEPTED", "EXPIRED", "WITHDRAWN"] as const) {
      expect(canAcceptQuote({ status, respondBy, expiresAt }, t0)).toBe(false);
    }
  });
});

describe("quoted items after payment", () => {
  it("start at ACCEPTED (the price was agreed), with no acceptance step", () => {
    expect(canTransition("QUOTE", "PAID", "ACCEPTED", "SYSTEM")).toBe(true);
    expect(canTransition("QUOTE", "PAID", "AWAITING_ACCEPTANCE", "SYSTEM")).toBe(false);
    expect(canTransition("QUOTE", "PAID", "ACCEPTED", "ADMIN")).toBe(false);
    expect(HAPPY_PATH.QUOTE).not.toContain("AWAITING_ACCEPTANCE");
  });
});
