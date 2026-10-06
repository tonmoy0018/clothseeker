import { describe, expect, it } from "vitest";

import { matchesFilters, parseProductFilters } from "@/lib/shop/catalog";

describe("parseProductFilters", () => {
  it("parses valid filters from search params", () => {
    expect(
      parseProductFilters({ category: "party", size: "M", color: "Sage", minPrice: "1000", maxPrice: "5000" }),
    ).toEqual({ category: "party", size: "M", color: "Sage", minPrice: 1000, maxPrice: 5000 });
  });

  it("drops invalid values instead of failing", () => {
    expect(
      parseProductFilters({ category: "../x", size: "HUGE", minPrice: "-5", maxPrice: "abc", color: "" }),
    ).toEqual({ category: undefined, size: undefined, color: undefined, minPrice: undefined, maxPrice: undefined });
  });

  it("uses the first value of repeated params", () => {
    expect(parseProductFilters({ size: ["S", "M"] }).size).toBe("S");
  });
});

describe("matchesFilters", () => {
  const variant = { size: "M" as const, colorName: "Sage", priceMinor: 320_000, stock: 2 };

  it("matches on size, color (case-insensitive) and price range in taka", () => {
    expect(matchesFilters(variant, { size: "M", color: "sage", minPrice: 3000, maxPrice: 3200 })).toBe(true);
    expect(matchesFilters(variant, { size: "L" })).toBe(false);
    expect(matchesFilters(variant, { maxPrice: 3199 })).toBe(false);
  });

  it("never matches sold-out variants", () => {
    expect(matchesFilters({ ...variant, stock: 0 }, {})).toBe(false);
  });
});
