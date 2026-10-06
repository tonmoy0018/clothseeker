// ClothSeeker sells in one currency. Amounts are integer minor units (1 BDT = 100 poisha)
// so arithmetic is exact; convert to a display string only at the edge.

export const CURRENCY = "BDT";
export const MINOR_PER_MAJOR = 100;

const whole = new Intl.NumberFormat("en-BD", {
  style: "currency",
  currency: CURRENCY,
  currencyDisplay: "narrowSymbol",
  maximumFractionDigits: 0,
});

const fractional = new Intl.NumberFormat("en-BD", {
  style: "currency",
  currency: CURRENCY,
  currencyDisplay: "narrowSymbol",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** 345000 → "৳3,450"; 345050 → "৳3,450.50". */
export function formatBDT(minor: number): string {
  if (!Number.isSafeInteger(minor)) {
    throw new RangeError("Money amounts must be safe integers in minor units");
  }
  const major = minor / MINOR_PER_MAJOR;
  return minor % MINOR_PER_MAJOR === 0 ? whole.format(major) : fractional.format(major);
}

/** Whole-taka user input (e.g. a price filter) → minor units. */
export function majorToMinor(major: number): number {
  return Math.round(major * MINOR_PER_MAJOR);
}

export function lineTotalMinor(unitPriceMinor: number, quantity: number): number {
  return unitPriceMinor * quantity;
}
