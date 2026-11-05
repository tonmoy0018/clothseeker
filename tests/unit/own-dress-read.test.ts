import { describe, expect, it } from "vitest";

import { ownDressName, parseGarmentReading, readStyle } from "@/lib/own-dress/read";

// What the AI reads in a customer's own garment photo: checked, trimmed, cleared of brand names, and
// dropped when unusable, so a bad answer only means "as if the AI hadn't been asked".

const good = {
  garmentType: "dress",
  name: "Floral tiered midi dress",
  description: "A light cotton dress with three gathered tiers.",
  box: { top: 80, left: 300, bottom: 950, right: 700 },
  neckline: "Square neck",
  sleeves: "Short puff sleeves",
  length: "Midi",
  colours: [
    { name: "Mustard", hex: "#d4a017" },
    { name: "White", hex: "#ffffff" },
  ],
  pattern: "small florals",
  details: ["smocked bodice", "tie belt"],
};

describe("reading a garment photo", () => {
  it("keeps a good reading: type, name, box as fractions, style, and a description for the team", () => {
    const reading = parseGarmentReading(good);
    expect(reading).toMatchObject({
      garmentType: "dress",
      name: "Floral tiered midi dress",
      box: { top: 0.08, left: 0.3, bottom: 0.95, right: 0.7 },
      style: { neckline: "Square neck", sleeves: "Short puff sleeves", length: "Midi" },
    });
    expect(reading?.description).toBe(
      "A light cotton dress with three gathered tiers. Colours: Mustard, White. Print or pattern: small florals. Details: smocked bodice, tie belt.",
    );
    expect(readStyle(reading, "collar")).toBe("Square neck");
    expect(readStyle(reading, "sleeveLength")).toBe("Short puff sleeves");
    expect(readStyle(reading, "fit")).toBeNull();
    expect(ownDressName(reading, "dress")).toBe("Your floral tiered midi dress");
  });

  it("drops brand names, markup and nonsense, and boxes that can't be the garment", () => {
    const reading = parseGarmentReading({
      ...good,
      name: "Gucci floral dress",
      description: "<script>alert(1)</script>",
      box: { top: 900, left: 100, bottom: 920, right: 900 },
      details: ["Nike swoosh", "ruffles"],
      garmentType: "jumpsuit",
    });
    expect(reading?.name).toBeNull();
    expect(reading?.box).toBeNull();
    expect(reading?.garmentType).toBeNull();
    expect(reading?.description).toContain("Details: ruffles.");
    expect(reading?.description).not.toMatch(/script|Nike/);
    expect(ownDressName(reading, "shirt")).toBe("Your shirt");
  });

  it("isn't a reading at all when the answer isn't an object", () => {
    expect(parseGarmentReading("a dress")).toBeNull();
    expect(parseGarmentReading(null)).toBeNull();
    // Missing fields are just unknown.
    expect(parseGarmentReading({})).toMatchObject({ garmentType: null, name: null, box: null, description: null });
  });
});
