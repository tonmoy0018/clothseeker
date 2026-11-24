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

  it("upgrades v1 configs all the way to v6 with default rects, fonts, add-ons and empty masks", () => {
    const upgraded = parseTemplateConfig(v1);
    expect(upgraded.schemaVersion).toBe(7);
    expect(upgraded.styleVariants).toEqual([]);
    expect(upgraded.recolor).toBe("multiply");
    expect(upgraded.garmentType).toBe("dress");
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
    expect(() => parseTemplateConfig({ ...DEFAULT_TEMPLATE_CONFIG, schemaVersion: 8 })).toThrow(TemplateConfigError);
    expect(() => parseTemplateConfig({ ...DEFAULT_TEMPLATE_CONFIG, schemaVersion: 0 })).toThrow(TemplateConfigError);
    expect(() => parseTemplateConfig({ regions: [] })).toThrow(TemplateConfigError);
  });

  it("upgrades v6 configs by offering embroidery and sequins at the default prices", () => {
    const { finishes: _f, ...v6 } = DEFAULT_TEMPLATE_CONFIG;
    expect(parseTemplateConfig({ ...v6, schemaVersion: 6 }).finishes).toEqual({ embroidery: 25_000, sequins: 35_000 });
    // null switches a finish off.
    expect(parseTemplateConfig({ ...DEFAULT_TEMPLATE_CONFIG, finishes: { embroidery: null, sequins: 35_000 } }).finishes.embroidery).toBeNull();
  });

  it("upgrades v2 configs by adding masks and decorations", () => {
    const { allowedDecorations: _d, styleVariants: _s, recolor: _r, garmentType: _g, ...v2 } = DEFAULT_TEMPLATE_CONFIG;
    const raw = { ...v2, schemaVersion: 2, regions: v2.regions.map(({ masks: _m, ...r }) => r) };
    const upgraded = parseTemplateConfig(raw);
    expect(upgraded.schemaVersion).toBe(7);
    expect(upgraded.regions.every((r) => JSON.stringify(r.masks) === "{}")).toBe(true);
  });

  it("upgrades v3 configs by adding an empty list of style pictures", () => {
    const { styleVariants: _s, recolor: _r, garmentType: _g, finishes: _f, ...v3 } = DEFAULT_TEMPLATE_CONFIG;
    const upgraded = parseTemplateConfig({ ...v3, schemaVersion: 3 });
    expect(upgraded).toEqual({ ...DEFAULT_TEMPLATE_CONFIG, schemaVersion: 7, styleVariants: [], recolor: "multiply" });
  });

  it("upgrades v4 configs to multiply recolouring, and accepts photo templates with a starting style", () => {
    const { recolor: _r, garmentType: _g, finishes: _f, ...v4 } = DEFAULT_TEMPLATE_CONFIG;
    expect(parseTemplateConfig({ ...v4, schemaVersion: 4 }).recolor).toBe("multiply");
    const photo = { ...DEFAULT_TEMPLATE_CONFIG, recolor: "shade", defaultStyle: { neckline: "v-neck", sleeveLength: "short", dressLength: "midi" } };
    expect(parseTemplateConfig(photo)).toEqual(photo);
    expect(() => parseTemplateConfig({ ...DEFAULT_TEMPLATE_CONFIG, recolor: "paint" })).toThrow();
  });

  it("upgrades v5 configs to dresses, and gives each garment type exactly its own style groups", () => {
    const { garmentType: _g, ...v5 } = DEFAULT_TEMPLATE_CONFIG;
    expect(parseTemplateConfig({ ...v5, schemaVersion: 5 }).garmentType).toBe("dress");

    const option = (id: string) => ({ id, label: id, addOnPriceMinor: 0 });
    const shirt = {
      ...DEFAULT_TEMPLATE_CONFIG,
      garmentType: "shirt",
      styleOptions: { collar: [option("classic"), option("mandarin")], sleeveLength: [option("short"), option("long")], fit: [option("slim"), option("regular")] },
    };
    expect(parseTemplateConfig(shirt).garmentType).toBe("shirt");
    // A shirt has no neckline or dress length, and needs a fit.
    const { fit: _fit, ...noFit } = shirt.styleOptions;
    const wrong = templateConfigSchema.safeParse({ ...shirt, styleOptions: { ...noFit, neckline: [option("round")] } });
    expect(wrong.success).toBe(false);
    const messages = wrong.success ? [] : wrong.error.issues.map((i) => i.message);
    expect(messages).toEqual(expect.arrayContaining(["Add the fit options", "A shirt has no neckline options"]));
  });

  it("lets a region's mask live only on style pictures", () => {
    const variant = { side: "front" as const, match: {}, image: KEY, masks: { bodice: KEY, sleeves: KEY, skirt: KEY, collar: KEY } };
    const config = templateConfigSchema.parse({ ...DEFAULT_TEMPLATE_CONFIG, garmentImages: { front: KEY, back: KEY }, styleVariants: [variant] });
    expect(activationProblems(config).join(" ")).not.toContain("Upload a mask");
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
