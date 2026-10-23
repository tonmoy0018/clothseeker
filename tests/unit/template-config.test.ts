import { describe, expect, it } from "vitest";

import { activationProblems } from "@/lib/admin/templates";
import { DECORATION_IDS } from "@/lib/catalog/decorations";
import { DEFAULT_TEMPLATE_CONFIG } from "@/lib/catalog/default-template";
import { parseTemplateConfig, TemplateConfigError, templateConfigSchema, templateImageKeys } from "@/types/template";

const KEY = "3f2b8a52-6c1e-4b7a-9d0f-1a2b3c4d5e6f/template/11111111-2222-4333-8444-555555555555.webp";

const v1 = {
  schemaVersion: 1,
  regions: [{ id: "bodice", label: "Bodice", recolorable: true }],
  placementAreas: [
    { id: "front-chest", label: "Front chest", side: "front", widthCm: 20, heightCm: 15 },
    { id: "back-upper", label: "Upper back", side: "back", widthCm: 30, heightCm: 25 },
  ],
  styleOptions: {
    neckline: [{ id: "round", label: "Round", addOnPriceMinor: 0 }],
    sleeveLength: [{ id: "short", label: "Short", addOnPriceMinor: 0 }],
    dressLength: [{ id: "midi", label: "Midi", addOnPriceMinor: 20_000 }],
  },
  allowedColors: [{ name: "Black", hex: "#1B1B1B" }],
};

describe("template config", () => {
  it("accepts the default v2 template", () => {
    expect(templateConfigSchema.safeParse(DEFAULT_TEMPLATE_CONFIG).success).toBe(true);
  });

  it("upgrades v1 configs all the way to v4 with default rects, fonts, add-ons and empty masks", () => {
    const upgraded = parseTemplateConfig(v1);
    expect(upgraded.schemaVersion).toBe(4);
    expect(upgraded.styleVariants).toEqual([]);
    expect(upgraded.regions[0]?.masks).toEqual({});
    expect(upgraded.allowedDecorations).toEqual([...DECORATION_IDS]);
    expect(upgraded.garmentImages).toEqual({});
    expect(upgraded.placementAreas.map((a) => a.rect)).toEqual([
      { x: 0.4, y: 0.2, w: 0.2, h: 0.14 },
      { x: 0.38, y: 0.18, w: 0.24, h: 0.18 },
    ]);
    expect(upgraded.allowedFonts).toEqual(["inter"]);
    expect(upgraded.addOns.textMinor).toBeGreaterThan(0);
  });

  it("rejects unknown versions and configs without a version", () => {
    expect(() => parseTemplateConfig({ ...DEFAULT_TEMPLATE_CONFIG, schemaVersion: 5 })).toThrow(TemplateConfigError);
    expect(() => parseTemplateConfig({ ...DEFAULT_TEMPLATE_CONFIG, schemaVersion: 0 })).toThrow(TemplateConfigError);
    expect(() => parseTemplateConfig({ regions: [] })).toThrow(TemplateConfigError);
  });

  it("upgrades v2 configs by adding masks and decorations", () => {
    const { allowedDecorations: _d, styleVariants: _s, ...v2 } = DEFAULT_TEMPLATE_CONFIG;
    const raw = { ...v2, schemaVersion: 2, regions: v2.regions.map(({ masks: _m, ...r }) => r) };
    const upgraded = parseTemplateConfig(raw);
    expect(upgraded.schemaVersion).toBe(4);
    expect(upgraded.regions.every((r) => JSON.stringify(r.masks) === "{}")).toBe(true);
  });

  it("upgrades v3 configs by adding an empty list of style pictures", () => {
    const { styleVariants: _s, ...v3 } = DEFAULT_TEMPLATE_CONFIG;
    const upgraded = parseTemplateConfig({ ...v3, schemaVersion: 3 });
    expect(upgraded).toEqual({ ...DEFAULT_TEMPLATE_CONFIG, schemaVersion: 4, styleVariants: [] });
  });

  it("lists every style-picture key once among the template's images", () => {
    const variant = { side: "front" as const, match: { neckline: "round" }, image: KEY, masks: { bodice: KEY, skirt: KEY } };
    const config = templateConfigSchema.parse({ ...DEFAULT_TEMPLATE_CONFIG, garmentImages: { front: KEY }, styleVariants: [variant, { ...variant, side: "back" }] });
    expect(templateImageKeys(config)).toEqual([KEY]);
  });

  it("requires a mask for every recolorable region before going live", () => {
    const withImages = { ...DEFAULT_TEMPLATE_CONFIG, garmentImages: { front: KEY, back: KEY } };
    expect(activationProblems(withImages).join(" ")).toContain("Upload a mask for: Bodice, Sleeves, Skirt, Collar.");
    const masked = { ...withImages, regions: withImages.regions.map((r) => ({ ...r, masks: { front: KEY } })) };
    expect(activationProblems(masked)).toEqual([]);
  });

  it("rejects placement rectangles outside the garment image", () => {
    const area = DEFAULT_TEMPLATE_CONFIG.placementAreas[0];
    if (!area) throw new Error("fixture");
    const bad = { ...DEFAULT_TEMPLATE_CONFIG, placementAreas: [{ ...area, rect: { x: 0.8, y: 0.1, w: 0.3, h: 0.1 } }] };
    expect(templateConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects unknown pattern/font ids, duplicate ids, bad colors and negative prices", () => {
    const cases = [
      { ...DEFAULT_TEMPLATE_CONFIG, allowedPatterns: ["camouflage"] },
      { ...DEFAULT_TEMPLATE_CONFIG, allowedFonts: ["comic-sans"] },
      { ...DEFAULT_TEMPLATE_CONFIG, regions: [...DEFAULT_TEMPLATE_CONFIG.regions, DEFAULT_TEMPLATE_CONFIG.regions[0]] },
      { ...DEFAULT_TEMPLATE_CONFIG, allowedColors: [{ name: "Bad", hex: "red" }] },
      { ...DEFAULT_TEMPLATE_CONFIG, addOns: { ...DEFAULT_TEMPLATE_CONFIG.addOns, textMinor: -1 } },
    ];
    for (const config of cases) {
      expect(templateConfigSchema.safeParse(config).success).toBe(false);
    }
  });

  it("rejects image references that aren't safe storage keys", () => {
    const bad = { ...DEFAULT_TEMPLATE_CONFIG, garmentImages: { front: "../../other-bucket/secret.png" } };
    expect(templateConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("lists every referenced image key", () => {
    const config = {
      ...DEFAULT_TEMPLATE_CONFIG,
      garmentImages: { front: KEY },
      styleOptions: {
        ...DEFAULT_TEMPLATE_CONFIG.styleOptions,
        neckline: [{ id: "round", label: "Round", addOnPriceMinor: 0, referenceImageKey: KEY.replace("template", "style") }],
      },
    };
    expect(templateImageKeys(templateConfigSchema.parse(config))).toEqual([KEY, KEY.replace("template", "style")]);
  });
});
