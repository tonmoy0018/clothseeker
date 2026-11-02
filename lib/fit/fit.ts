import { z } from "zod";

import { GARMENT_TYPES, type GarmentType } from "@/lib/catalog/garment-types";
import { SIZE_ORDER, sizeChartFor } from "@/lib/catalog/size-chart";
import type { Size } from "@/lib/generated/prisma/enums";

// How a size fits a customer, from their height and weight (decided 2026-11-02: height + weight only,
// a Fitted / Regular / Relaxed choice, a report and a try-on picture that follows the fit). Pure and
// shared by the browser (the report) and the worker (the try-on's shape), so both agree.
//
// Body sizes are ESTIMATES: girths scale with weight per height, calibrated so a typical person lands in
// the middle of size M (160 cm/57 kg women's, 172 cm/68 kg men's), waists following weight more strongly
// than bust or hips. The report says so.

export const FIT_PREFERENCES = ["fitted", "regular", "relaxed"] as const;
export type FitPreference = (typeof FIT_PREFERENCES)[number];

export const FIT_PREFERENCE_LABEL: Record<FitPreference, string> = { fitted: "Fitted", regular: "Regular", relaxed: "Relaxed" };

export const fitInputSchema = z.object({
  heightCm: z.coerce.number().int("Enter your height in whole centimetres.").min(120, "Height must be 120–220 cm.").max(220, "Height must be 120–220 cm."),
  weightKg: z.coerce.number().int("Enter your weight in whole kilograms.").min(30, "Weight must be 30–200 kg.").max(200, "Weight must be 30–200 kg."),
  preference: z.enum(FIT_PREFERENCES),
});
export type FitInput = z.infer<typeof fitInputSchema>;

/** A try-on's fit: the customer's height, weight and preference, and the size they're trying. */
export const tryOnFitSchema = fitInputSchema.extend({ size: z.enum(SIZE_ORDER) });
export type TryOnFit = z.infer<typeof tryOnFitSchema>;

/** The typical person in the middle of size M, and how strongly each girth follows weight per height. */
const MODEL = {
  women: { heightCm: 160, weightKg: 57, girths: [89, 71, 95], exponents: [0.55, 0.75, 0.5], weights: [1, 0.6, 0.8] },
  men: { heightCm: 172, weightKg: 68, girths: [97, 83, 39.5], exponents: [0.55, 0.8, 0.4], weights: [1, 0.6, 0.4] },
} as const;

/** Where in a size's range each preference wants the body: near the top is snug, near the bottom loose. */
const TARGET: Record<FitPreference, number> = { fitted: 0.8, regular: 0.5, relaxed: 0.2 };

/** Estimated girths (cm) in the order of the garment's size chart columns. */
export function estimateGirths(type: GarmentType, body: Pick<FitInput, "heightCm" | "weightKg">): number[] {
  const model = MODEL[GARMENT_TYPES[type].audience];
  const ratio = body.weightKg / body.heightCm / (model.weightKg / model.heightCm);
  return model.girths.map((girth, i) => Math.round(girth * ratio ** (model.exponents[i] ?? 0.5) * 10) / 10);
}

export type FitStatus = "tight" | "good" | "loose";

export type FitLine = {
  /** "Bust", "Waist", … */
  label: string;
  bodyCm: number;
  /** The body range this size is made for. */
  rangeCm: readonly [number, number];
  status: FitStatus;
  /** How far outside the range (0 inside it). */
  byCm: number;
};

export type SizeFit = { size: Size; lines: FitLine[]; score: number };

function sizeFit(type: GarmentType, girths: number[], size: Size, preference: FitPreference): SizeFit | null {
  const chart = sizeChartFor(type);
  const row = chart.rows.find((r) => r.size === size);
  if (!row) return null;
  const model = MODEL[GARMENT_TYPES[type].audience];
  let score = 0;
  const lines = chart.columns.map((label, i): FitLine => {
    const range = row.cm[i] ?? [0, 0];
    const body = girths[i] ?? 0;
    const [lo, hi] = range;
    const target = lo + TARGET[preference] * (hi - lo);
    // Too small hurts more than too big: a garment can be worn loose, not tight.
    score += (model.weights[i] ?? 1) * (Math.abs(body - target) + (body > hi ? 3 * (body - hi) : 0));
    if (body > hi + 1) return { label, bodyCm: body, rangeCm: range, status: "tight", byCm: Math.round(body - hi) };
    if (body < lo - 1) return { label, bodyCm: body, rangeCm: range, status: "loose", byCm: Math.round(lo - body) };
    return { label, bodyCm: body, rangeCm: range, status: "good", byCm: 0 };
  });
  return { size, lines, score };
}

export type FitReport = {
  girths: number[];
  /** The size of `sizes` that best matches the preference. */
  recommended: Size | null;
  /** How the chosen size fits. */
  chosen: SizeFit | null;
  /** Where the hem lands on this person, when the garment's length is known. */
  hem: HemPlace | null;
};

/** The fit of `size` and the best of `sizes` (those on sale) for this person and preference. */
export function fitReport(type: GarmentType, input: FitInput, sizes: readonly Size[], size: Size | null, lengthCm: number | null): FitReport {
  const girths = estimateGirths(type, input);
  const fits = SIZE_ORDER.filter((s) => sizes.includes(s)).flatMap((s) => sizeFit(type, girths, s, input.preference) ?? []);
  const best = fits.reduce<SizeFit | null>((a, b) => (a === null || b.score < a.score ? b : a), null);
  const chosen = size ? sizeFit(type, girths, size, input.preference) : null;
  const hem = lengthCm && size ? hemPlace(input.heightCm, gradedLength(lengthCm, size)) : null;
  return { girths, recommended: best?.size ?? null, chosen, hem };
}

/**
 * How much wider or narrower than usual the garment sits on this person in this size: the middle of the
 * size's range against their body, on the main girth (bust or chest). 1 = as made for them; above 1
 * loose, below 1 tight. Clamped to what still looks like the same garment.
 */
export function widthFactor(type: GarmentType, fit: TryOnFit): number {
  const girths = estimateGirths(type, fit);
  const row = sizeChartFor(type).rows.find((r) => r.size === fit.size);
  const range = row?.cm[0];
  const body = girths[0];
  if (!range || !body) return 1;
  const middle = (range[0] + range[1]) / 2;
  return Math.min(1.3, Math.max(0.85, 1 + (middle - body) / body));
}

// ─── length ──────────────────────────────────────────────────────────────────

/**
 * Heights above the floor as a share of body height (standard proportions): the high point of the
 * shoulder (where garment lengths are measured from), hip joint, knee, ankle.
 */
export const BODY_LEVELS = { neckShoulder: 0.845, shoulder: 0.82, hip: 0.53, knee: 0.285, ankle: 0.04 } as const;

/** Lengths in the catalogue are for size M; each size up or down adds or takes 1.5 cm. */
export function gradedLength(lengthCm: number, size: Size): number {
  return lengthCm + 1.5 * (SIZE_ORDER.indexOf(size) - SIZE_ORDER.indexOf("M"));
}

/** Places on the leg a hem is described by: "at the knee", "4 cm below the knee". */
const PLACES: readonly { level: number; at: string; ref: string }[] = [
  { level: BODY_LEVELS.hip, at: "at the hips", ref: "the hips" },
  { level: 0.41, at: "mid-thigh", ref: "mid-thigh" },
  { level: BODY_LEVELS.knee, at: "at the knee", ref: "the knee" },
  { level: 0.17, at: "mid-calf", ref: "mid-calf" },
  { level: BODY_LEVELS.ankle, at: "at the ankle", ref: "the ankle" },
];

export type HemPlace = {
  /** Hem height above the floor as a share of body height (0 or below: it reaches the floor). */
  level: number;
  /** "at the knee", "6 cm below the knee", "on the floor" … */
  words: string;
};

/** Where a garment `lengthCm` long (from the shoulder) ends on someone `heightCm` tall. */
export function hemPlace(heightCm: number, lengthCm: number): HemPlace {
  const level = (BODY_LEVELS.neckShoulder * heightCm - lengthCm) / heightCm;
  if (level <= 0.01) return { level, words: "on the floor" };
  const closest = PLACES.reduce((a, b) => (Math.abs(b.level - level) < Math.abs(a.level - level) ? b : a));
  const offCm = Math.round((level - closest.level) * heightCm);
  const words = Math.abs(offCm) < 3 ? closest.at : `${Math.abs(offCm)} cm ${offCm > 0 ? "above" : "below"} ${closest.ref}`;
  return { level, words };
}

/** Catalogue lengths (cm from the shoulder, size M) of the default length options, by option id. */
export const STYLE_LENGTH_CM: Readonly<Record<string, number>> = {
  mini: 85,
  knee: 100,
  midi: 115,
  maxi: 140,
  hip: 78,
  long: 112,
};

/** A shirt's usual length, when nothing else says. */
const SHIRT_LENGTH_CM = 74;

/** The garment's length (size M): the chosen length option, else the product's listed length. */
export function garmentLengthCm(type: GarmentType, styleOptions: Partial<Record<string, string>> | null, productLengthCm: number | null): number | null {
  const option = styleOptions?.dressLength ?? styleOptions?.length;
  if (option && STYLE_LENGTH_CM[option] !== undefined) return STYLE_LENGTH_CM[option] ?? null;
  if (productLengthCm) return productLengthCm;
  return type === "shirt" ? SHIRT_LENGTH_CM : null;
}
