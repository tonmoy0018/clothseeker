import { describe, expect, it } from "vitest";

import { SIZE_ORDER } from "@/lib/catalog/size-chart";
import { fitInputSchema, fitReport, garmentLengthCm, gradedLength, hemPlace, widthFactor, type BodyGirth } from "@/lib/fit/fit";

// Fit from height and the measurements taken from the photo: the size made for the body, how the chosen
// size fits, where the hem lands, and how wide the try-on draws it.

const ALL = SIZE_ORDER;
const measured = (...cm: number[]): BodyGirth[] => cm.map((c) => ({ cm: c, estimated: false }));
/** The middle of size M in the women's chart. */
const MIDDLE_M = measured(89, 71, 95);

describe("the customer's input", () => {
  it("is their height, nothing else", () => {
    expect(fitInputSchema.safeParse({ heightCm: "165", weightKg: 60, preference: "relaxed" }).data).toEqual({ heightCm: 165 });
    expect(fitInputSchema.safeParse({ heightCm: 90 }).success).toBe(false);
    expect(fitInputSchema.safeParse({ heightCm: 165.5 }).success).toBe(false);
  });
});

describe("recommending a size", () => {
  const recommend = (girths: BodyGirth[], sizes = ALL) => fitReport("dress", { heightCm: 160 }, girths, sizes, null, null).recommended;

  it("picks the size made for the body", () => {
    expect(recommend(MIDDLE_M)).toBe("M");
    expect(recommend(measured(80, 62, 86))).toBe("XS");
    expect(recommend(measured(102, 84, 108))).toBe("XL");
    // A waist beyond XL's range: the next size up, rather than a tight one.
    expect(recommend(measured(102, 95, 108))).toBe("XXL");
  });

  it("never recommends a size that would be tight", () => {
    for (const bust of [80, 84, 88, 92, 96, 100, 104, 108]) {
      const body = measured(bust, bust - 18, bust + 6);
      const size = recommend(body);
      const report = fitReport("dress", { heightCm: 160 }, body, ALL, size, null);
      expect(report.chosen?.lines.some((l) => l.status === "tight")).toBe(false);
    }
  });

  it("only recommends sizes on sale", () => {
    expect(recommend(measured(80, 62, 86), ["M", "L"])).toBe("M");
  });

  it("counts a guessed measurement for less than a measured one", () => {
    // Bust and hips say S; a waist the photo didn't show (guessed big) mustn't outvote them.
    const body: BodyGirth[] = [
      { cm: 84, estimated: false },
      { cm: 72, estimated: true },
      { cm: 90, estimated: false },
    ];
    expect(recommend(body)).toBe("S");
    const lines = fitReport("dress", { heightCm: 160 }, body, ALL, "S", null).chosen?.lines;
    expect(lines?.map((l) => l.estimated)).toEqual([false, true, false]);
  });

  it("says how the chosen size fits, per measurement", () => {
    const tight = fitReport("dress", { heightCm: 160 }, measured(100, 82, 106), ALL, "S", null).chosen;
    expect(tight?.lines.map((l) => [l.label, l.status])).toEqual([
      ["Bust", "tight"],
      ["Waist", "tight"],
      ["Hip", "tight"],
    ]);
    expect(tight?.lines[0]?.byCm).toBeGreaterThan(10);
    const loose = fitReport("dress", { heightCm: 160 }, measured(78, 60, 84), ALL, "L", null).chosen;
    expect(loose?.lines.every((l) => l.status === "loose")).toBe(true);
  });

  it("without measurements, only says where the hem lands", () => {
    const report = fitReport("dress", { heightCm: 165 }, null, ALL, "M", 100);
    expect(report.recommended).toBeNull();
    expect(report.chosen).toBeNull();
    expect(report.hem?.words).toMatch(/knee/);
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
    const fit = (size: "XS" | "S" | "M" | "L" | "XL" | "XXL", girthsCm: number[] | null = [89, 71, 95]) => widthFactor("dress", { heightCm: 160, size, girthsCm });
    expect(fit("M")).toBe(1);
    expect(fit("XL")).toBeGreaterThan(1.1);
    expect(fit("XS")).toBeLessThan(0.95);
    expect(fit("XXL")).toBeLessThanOrEqual(1.3);
    expect(fit("XS", [140, 120, 150])).toBe(0.85);
    // Not measured: drawn as made.
    expect(fit("XL", null)).toBe(1);
  });
});
