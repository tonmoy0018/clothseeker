import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { normalizeForRender } from "@/lib/design/normalize";
import { basePriceForSize, priceDesign } from "@/lib/design/pricing";
import { layerFitsArea, validateDesignAgainstTemplate } from "@/lib/design/validate";
import { DesignSpecError, parseDesignSpec, type DesignSpec } from "@/types/design-spec";

import { CONTEXT, CUSTOMER_ID, KEYS, TEMPLATE, validSpec } from "../fixtures/design";

const chest = TEMPLATE.placementAreas.find((a) => a.id === "front-chest");
if (!chest) throw new Error("fixture");

function issuesFor(spec: DesignSpec, ctx = CONTEXT) {
  return validateDesignAgainstTemplate(spec, TEMPLATE, ctx).map((i) => i.path);
}

describe("parseDesignSpec", () => {
  it("accepts a valid spec and lowercases colors", () => {
    const spec = parseDesignSpec({ ...validSpec(), parts: { skirt: { color: "#1F6F50" } } });
    expect(spec.parts.skirt?.color).toBe("#1f6f50");
  });

  it("rejects unknown versions, kinds, fonts and malformed text", () => {
    expect(() => parseDesignSpec({ ...validSpec(), version: 2 })).toThrow(DesignSpecError);
    const base = validSpec();
    const [text] = base.layers;
    if (!text || text.kind !== "text") throw new Error("fixture");
    const bad = [
      { ...base, layers: [{ ...text, kind: "video" }] },
      { ...base, layers: [{ ...text, text: { ...text.text, fontId: "comic-sans" } }] },
      { ...base, layers: [{ ...text, text: { ...text.text, content: "a".repeat(61) } }] },
      { ...base, layers: [{ ...text, text: { ...text.text, content: "bad\u0000text" } }] },
      { ...base, layers: [{ ...text, x: 1.5 }] },
      { ...base, layers: Array.from({ length: 31 }, (_, i) => ({ ...text, id: `t${i}` })) },
      { ...base, referencePhotoKey: "../../secret.png" },
    ];
    for (const raw of bad) {
      expect(() => parseDesignSpec(raw)).toThrow(ZodError);
    }
  });
});

describe("validateDesignAgainstTemplate", () => {
  it("accepts the valid fixture", () => {
    expect(issuesFor(validSpec())).toEqual([]);
  });

  it("rejects the wrong product/template and unavailable sizes", () => {
    expect(issuesFor(validSpec({ productId: "11111111-1111-4111-8111-111111111111" }))).toContain("productId");
    expect(issuesFor(validSpec({ templateId: "11111111-1111-4111-8111-111111111111" }))).toContain("templateId");
    expect(issuesFor(validSpec({ size: "XXL" }))).toContain("size");
  });

  it("rejects unknown style options, regions, colors and patterns", () => {
    expect(issuesFor(validSpec({ styleOptions: { neckline: "plunge", sleeveLength: "short", dressLength: "midi" } }))).toContain(
      "styleOptions.neckline",
    );
    expect(issuesFor(validSpec({ parts: { lining: { color: "#1f6f50" } } }))).toContain("parts.lining");
    expect(issuesFor(validSpec({ parts: { pocket: { color: "#1f6f50" } } }))).toContain("parts.pocket");
    expect(issuesFor(validSpec({ parts: { skirt: { color: "#123456" } } }))).toContain("parts.skirt.color");
    expect(issuesFor(validSpec({ parts: { skirt: { color: "#1f6f50", pattern: { id: "plaid", color: "#f5f5f0" } } } }))).toContain(
      "parts.skirt.pattern",
    );
  });

  it("rejects fonts, decorations and areas the template doesn't allow", () => {
    const spec = validSpec();
    const [text, deco] = spec.layers;
    if (text?.kind !== "text" || deco?.kind !== "decoration") throw new Error("fixture");
    expect(issuesFor({ ...spec, layers: [{ ...text, text: { ...text.text, fontId: "lobster" } }] })).toContain("layers.0.text.fontId");
    expect(issuesFor({ ...spec, layers: [{ ...text, areaId: "sleeve" }] })).toContain("layers.0.areaId");
    expect(issuesFor({ ...spec, layers: [{ ...deco, decoration: { id: "moon", color: "#123456" } }] })).toContain(
      "layers.0.decoration.color",
    );
  });

  it("rejects layers that leave their area, including through rotation", () => {
    const spec = validSpec();
    const [text] = spec.layers;
    if (!text) throw new Error("fixture");
    expect(issuesFor({ ...spec, layers: [{ ...text, x: 0.5, w: 0.6 }] })).toContain("layers.0");
    // Fits unrotated, but a 45° turn pushes the corners out.
    const square = { ...text, x: 0, y: 0, w: 1, h: 1, rotation: 0 };
    expect(layerFitsArea(square, chest)).toBe(true);
    expect(layerFitsArea({ ...square, rotation: 45 }, chest)).toBe(false);
    expect(layerFitsArea({ ...square, x: 0.3, y: 0.3, w: 0.4, h: 0.4, rotation: 45 }, chest)).toBe(true);
  });

  it("only allows images uploaded by the design's own customer", () => {
    const image = { id: "i1", areaId: "front-chest", kind: "image" as const, x: 0.1, y: 0.1, w: 0.5, h: 0.5, rotation: 0 };
    const own = { ...image, image: { assetKey: KEYS.upload } };
    const other = { ...image, image: { assetKey: "99999999-2222-4333-8444-555566667777/uploads/x.webp" } };
    expect(issuesFor(validSpec({ layers: [own] }))).toEqual([]);
    expect(issuesFor(validSpec({ layers: [other] }))).toContain("layers.0.image");
    expect(issuesFor(validSpec({ layers: [own] }), { ...CONTEXT, customerId: null })).toContain("layers.0.image");
  });

  it("limits layers per area and rejects duplicate layer ids", () => {
    const [text] = validSpec().layers;
    if (!text) throw new Error("fixture");
    const many = Array.from({ length: 13 }, (_, i) => ({ ...text, id: `t${i}` }));
    expect(issuesFor(validSpec({ layers: many }))).toContain("layers.12.areaId");
    expect(issuesFor(validSpec({ layers: [text, text] }))).toContain("layers.1");
  });
});

describe("pricing", () => {
  it("uses the cheapest active variant in the size as the base", () => {
    const variants = [
      { size: "M", priceMinor: 320_000, isActive: true },
      { size: "M", priceMinor: 300_000, isActive: true },
      { size: "M", priceMinor: 100_000, isActive: false },
      { size: "L", priceMinor: 280_000, isActive: true },
    ];
    expect(basePriceForSize(variants, "M")).toBe(300_000);
    expect(basePriceForSize(variants, "XL")).toBeNull();
  });

  it("adds style options, patterns and layers from the template's rules", () => {
    const price = priceDesign(validSpec(), TEMPLATE, 300_000);
    expect(price.lines).toEqual([
      { label: "Dress, size M", amountMinor: 300_000 },
      { label: "Neckline: Square", amountMinor: 15_000 },
      { label: "Length: Midi", amountMinor: 20_000 },
      { label: "Pattern", amountMinor: 20_000 },
      { label: "Text", amountMinor: 15_000 },
      { label: "Decoration", amountMinor: 10_000 },
    ]);
    expect(price.totalMinor).toBe(380_000);
  });

  it("charges per layer", () => {
    const [text] = validSpec().layers;
    if (!text) throw new Error("fixture");
    const spec = validSpec({ parts: {}, layers: [text, { ...text, id: "t2" }, { ...text, id: "t3" }] });
    expect(priceDesign(spec, TEMPLATE, 0).lines).toContainEqual({ label: "Text × 3", amountMinor: 45_000 });
  });
});

describe("normalizeForRender", () => {
  it("orders fills by template region order and drops regions without a mask on that side", () => {
    const plan = normalizeForRender(validSpec(), TEMPLATE);
    expect(plan.front.fills.map((f) => f.regionId)).toEqual(["bodice", "skirt"]);
    expect(plan.back.fills.map((f) => f.regionId)).toEqual(["skirt"]);
    expect(plan.front.fills[1]?.pattern).toEqual({ id: "polka-dots", color: "#f5f5f0" });
  });

  it("rounds geometry and lists only areas with layers as print areas", () => {
    const [text] = validSpec().layers;
    if (!text) throw new Error("fixture");
    const plan = normalizeForRender(validSpec({ layers: [{ ...text, x: 0.123456789, rotation: 12.3456 }] }), TEMPLATE);
    expect(plan.printAreas.map((a) => a.areaId)).toEqual(["front-chest"]);
    expect(plan.printAreas[0]?.layers[0]).toMatchObject({ x: 0.1235, rotation: 12.3 });
  });

  it("is independent of the order of keys in parts", () => {
    const a = validSpec();
    const b = validSpec({ parts: { bodice: { color: "#1f6f50" }, skirt: a.parts.skirt ?? { color: "#1f6f50" } } });
    expect(JSON.stringify(normalizeForRender(a, TEMPLATE))).toBe(JSON.stringify(normalizeForRender(b, TEMPLATE)));
  });

  it("references only the customer's upload for image layers", () => {
    const spec = validSpec({
      layers: [{ id: "i1", areaId: "front-skirt", kind: "image", x: 0, y: 0, w: 1, h: 1, rotation: 0, image: { assetKey: KEYS.upload } }],
    });
    const op = normalizeForRender(spec, TEMPLATE).printAreas[0]?.layers[0];
    expect(op).toMatchObject({ kind: "image", assetKey: `${CUSTOMER_ID}/uploads/12345678-1111-4111-8111-111111111111.webp` });
  });
});
