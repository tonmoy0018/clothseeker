import { describe, expect, it } from "vitest";

import { formatBDT, lineTotalMinor, majorToMinor } from "@/lib/money";

describe("money", () => {
  it("formats whole and fractional taka", () => {
    expect(formatBDT(345_000)).toBe("৳3,450");
    expect(formatBDT(345_050)).toBe("৳3,450.50");
    expect(formatBDT(0)).toBe("৳0");
  });

  it("rejects non-integer minor amounts", () => {
    expect(() => formatBDT(1.5)).toThrow(RangeError);
  });

  it("converts and multiplies exactly", () => {
    expect(majorToMinor(3450)).toBe(345_000);
    expect(majorToMinor(19.99)).toBe(1999);
    expect(lineTotalMinor(320_000, 3)).toBe(960_000);
  });
});
