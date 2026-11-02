import { describe, expect, it } from "vitest";

import { SIZE_ORDER } from "@/lib/catalog/size-chart";
import { estimateGirths, fitInputSchema, fitReport, garmentLengthCm, gradedLength, hemPlace, widthFactor } from "@/lib/fit/fit";

// Fit from height and weight: estimated girths, the recommended size for a Fitted / Regular / Relaxed
// preference, how the chosen size fits, where the hem lands, and how wide the try-on draws it.

const ALL = SIZE_ORDER;

describe("estimating the body", () => {
  it("puts the typical person in the middle of size M, and grows with weight per height", () => {
    expect(estimateGirths("dress", { heightCm: 160, weightKg: 57 })).toEqual([89, 71, 95]);
    expect(estimateGirths("shirt", { heightCm: 172, weightKg: 68 })).toEqual([97, 83, 39.5]);
    const [bust, waist] = estimateGirths("dress", { heightCm: 160, weightKg: 75 });
    expect(bust).toBeGreaterThan(98);
    // The waist follows weight more than the bust does.
    expect((waist ?? 0) / 71).toBeGreaterThan((bust ?? 0) / 89);
  });

  it("accepts sensible heights and weights only", () => {
    expect(fitInputSchema.safeParse({ heightCm: "165", weightKg: "58", preference: "regular" }).success).toBe(true);
    expect(fitInputSchema.safeParse({ heightCm: 90, weightKg: 58, preference: "regular" }).success).toBe(false);
    expect(fitInputSchema.safeParse({ heightCm: 165, weightKg: 58.5, preference: "regular" }).success).toBe(false);
    expect(fitInputSchema.safeParse({ heightCm: 165, weightKg: 58, preference: "baggy" }).success).toBe(false);
  });
});

describe("recommending a size", () => {
  const recommend = (heightCm: number, weightKg: number, preference: "fitted" | "regular" | "relaxed", sizes = ALL) => fitReport("dress", { heightCm, weightKg, preference }, sizes, null, null).recommended;

  it("picks the size made for the body", () => {
    expect(recommend(160, 57, "regular")).toBe("M");
    expect(recommend(160, 45, "regular")).toBe("XS");
    expect(recommend(160, 74, "regular")).toBe("XL");
    // A waist beyond XL's range: the next size up, rather than a tight one.
    expect(recommend(160, 78, "regular")).toBe("XXL");
  });

  it("goes smaller for Fitted and bigger for Relaxed, never tight", () => {
    const fitted = recommend(160, 60, "fitted");
    const relaxed = recommend(160, 60, "relaxed");
    expect(ALL.indexOf(relaxed ?? "M")).toBeGreaterThan(ALL.indexOf(fitted ?? "M"));
    const report = fitReport("dress", { heightCm: 160, weightKg: 60, preference: "fitted" }, ALL, fitted, null);
    expect(report.chosen?.lines.some((l) => l.status === "tight")).toBe(false);
  });

  it("only recommends sizes on sale", () => {
    expect(recommend(160, 45, "regular", ["M", "L"])).toBe("M");
  });

  it("says how the chosen size fits, per measurement", () => {
    const tight = fitReport("dress", { heightCm: 160, weightKg: 75, preference: "regular" }, ALL, "S", null).chosen;
    expect(tight?.lines.map((l) => [l.label, l.status])).toEqual([
      ["Bust", "tight"],
      ["Waist", "tight"],
      ["Hip", "tight"],
    ]);
    expect(tight?.lines[0]?.byCm).toBeGreaterThan(10);
    const loose = fitReport("dress", { heightCm: 160, weightKg: 45, preference: "regular" }, ALL, "L", null).chosen;
    expect(loose?.lines.every((l) => l.status === "loose")).toBe(true);
  });
});

describe("length", () => {
  it("lands the same dress lower on a shorter person", () => {
    expect(hemPlace(175, 140).words).toBe("at the ankle");
    expect(hemPlace(155, 140).words).toBe("on the floor");
    const midi = (h: number) => hemPlace(h, 115).level;
    expect(midi(150)).toBeLessThan(midi(180));
    expect(hemPlace(165, 100).words).toMatch(/knee/);
  });

  it("describes a hem between places in centimetres", () => {
    expect(hemPlace(160, 115).words).toMatch(/^\d+ cm (above|below) (mid-calf|the knee)$/);
  });

  it("grades lengths by size and finds the garment's length", () => {
    expect(gradedLength(115, "M")).toBe(115);
    expect(gradedLength(115, "XL")).toBe(118);
    expect(gradedLength(115, "XS")).toBe(112);
    expect(garmentLengthCm("dress", { dressLength: "maxi" }, null)).toBe(140);
    expect(garmentLengthCm("panjabi", { length: "knee" }, null)).toBe(100);
    expect(garmentLengthCm("dress", null, 128)).toBe(128);
    expect(garmentLengthCm("dress", null, null)).toBeNull();
    expect(garmentLengthCm("shirt", null, null)).toBe(74);
  });
});

describe("the try-on's width", () => {
  it("is 1 for the size made for the person, wider when it's big, narrower when it's small, within limits", () => {
    const fit = (size: "XS" | "S" | "M" | "L" | "XL" | "XXL") => widthFactor("dress", { heightCm: 160, weightKg: 57, preference: "regular", size });
    expect(fit("M")).toBe(1);
    expect(fit("XL")).toBeGreaterThan(1.1);
    expect(fit("XS")).toBeLessThan(0.95);
    expect(fit("XXL")).toBeLessThanOrEqual(1.3);
    expect(widthFactor("dress", { heightCm: 150, weightKg: 120, preference: "regular", size: "XS" })).toBe(0.85);
  });
});
