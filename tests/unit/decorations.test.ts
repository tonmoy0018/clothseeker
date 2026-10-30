import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";

import {
  borderBox,
  borderMotifSize,
  borderSpacing,
  decorationLayerSvg,
  decorationSvg,
  hasDetail,
  isPlainDecoration,
  motifCount,
  repeatLayout,
} from "@/lib/catalog/decorations";
import { normalizeForRender } from "@/lib/design/normalize";
import { priceDesign } from "@/lib/design/pricing";
import { validateDesignAgainstTemplate } from "@/lib/design/validate";
import { decorationDescription } from "@/lib/production/spec-data";
import { renderPreview, storageAssets, type Assets } from "@/lib/renderer/render";
import { designSpecSchema, type DesignSpec } from "@/types/design-spec";

import { CONTEXT, storageWithTemplateAssets, TEMPLATE, validSpec } from "../fixtures/design";

// Customised decorations: a second colour for the detail, outline drawing, mirroring, and borders
// (a curved row of repeats priced per motif).

type Decoration = Extract<DesignSpec["layers"][number], { kind: "decoration" }>["decoration"];

/** The fixture design with its heart decoration (d1) changed. */
function withDecoration(change: Partial<Decoration>, box?: { x: number; y: number; w: number; h: number }): DesignSpec {
  const spec = validSpec();
  return {
    ...spec,
    layers: spec.layers.map((l) => (l.kind === "decoration" ? { ...l, ...(box ?? {}), decoration: { ...l.decoration, ...change } } : l)),
  };
}

describe("drawing customised decorations", () => {
  it("keeps the plain look exactly when nothing is customised", () => {
    expect(isPlainDecoration({ color: "#e8a0b4" }, undefined)).toBe(true);
    expect(isPlainDecoration({ color: "#e8a0b4", mirror: true }, undefined)).toBe(false);
    expect(decorationSvg("heart", "#e8a0b4", 100)).toContain('fill="#e8a0b4"');
  });

  it("draws the detail, outline and mirror", () => {
    const flower = decorationLayerSvg("flower", { color: "#1f6f50", detail: "#c9a227" }, null, 200, 200);
    expect(flower).toContain('fill="#1f6f50"');
    expect(flower).toContain('fill="#c9a227"');
    const outline = decorationLayerSvg("star", { color: "#1b1b1b", style: "outline", outline: 8 }, null, 200, 200);
    expect(outline).toContain('fill="none" stroke="#1b1b1b" stroke-width="8"');
    expect(decorationLayerSvg("leaf", { color: "#1f6f50", mirror: true }, null, 100, 100)).toContain("scale(-1 1)");
    // Untrusted colours never reach the SVG: they're refused.
    expect(() => decorationLayerSvg("star", { color: '"/><script>' }, null, 50, 50)).toThrow();
    expect(hasDetail("flower")).toBe(true);
    expect(hasDetail("star")).toBe(false);
  });

  it("lays a border out evenly, sagging in the middle for a U and arching for a negative curve", () => {
    const straight = repeatLayout(5, 0, 500, 100);
    expect(straight).toHaveLength(5);
    expect(straight.map((p) => Math.round(p.x))).toEqual([50, 150, 250, 350, 450]);
    expect(new Set(straight.map((p) => p.y)).size).toBe(1);
    const u = repeatLayout(5, 1, 500, 100);
    expect(u[2]?.y ?? 0).toBeGreaterThan(u[0]?.y ?? 0);
    expect(u[0]?.angle ?? 0).toBeGreaterThan(0); // the left end tilts down towards the middle
    const arch = repeatLayout(5, -1, 500, 100);
    expect(arch[2]?.y ?? 0).toBeLessThan(arch[0]?.y ?? 0);
    // Motifs never overflow the box.
    for (const p of [...straight, ...u, ...arch]) {
      expect(p.x - p.size / 2).toBeGreaterThanOrEqual(-0.01);
      expect(p.y + p.size / 2).toBeLessThanOrEqual(100.01);
    }
    expect(decorationLayerSvg("star", { color: "#1b1b1b" }, { count: 7, curve: 0.5 }, 700, 120).match(/<g transform="translate/g)).toHaveLength(7);
    expect(motifCount({ count: 7, curve: 0 })).toBe(7);
    expect(motifCount(undefined)).toBe(1);
  });

  it("sizes a border box from count, spacing and curve, staying inside the area", () => {
    const area = { width: 20, height: 15 };
    const start = { x: 0.4, y: 0.4, w: 0.15, h: 0.2 };
    const box = borderBox(start, area, 6, 0.3, 0);
    // 6 motifs of 3 cm with 5 gaps of 0.9 cm = 22.5 cm: too wide for 20 cm, so everything shrinks.
    expect(box.w).toBeCloseTo(1);
    expect(box.h).toBeLessThan(0.2);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.w).toBeLessThanOrEqual(1.0001);
    const small = borderBox(start, area, 3, 0.5, 0);
    expect(borderSpacing(small, area, 3, 0)).toBeCloseTo(0.5, 2);
    // Curving keeps the motifs' size and makes the box taller for the bend.
    const curved = borderBox(small, area, 3, 0.5, 0.8, 0);
    expect(curved.h).toBeGreaterThan(small.h * 1.8);
    expect(borderMotifSize(curved.h * area.height, 0.8)).toBeCloseTo(borderMotifSize(small.h * area.height, 0), 2);
    // A whole-front area trimmed to the fabric keeps borders to its middle.
    expect(borderBox(start, area, 6, 0.3, 0, 0, 0.6).w).toBeCloseTo(0.6);
    // Back to a single motif: a square box.
    const single = borderBox(small, area, 1, 0, 0);
    expect(single.w * area.width).toBeCloseTo(single.h * area.height, 2);
  });
});

describe("rules for customised decorations", () => {
  it("accepts allowed colours and borders, and refuses a detail colour where it can't go", () => {
    expect(validateDesignAgainstTemplate(withDecoration({ mirror: true, style: "outline", outline: 6 }), TEMPLATE, CONTEXT)).toEqual([]);
    const flower = withDecoration({ id: "flower", detail: "#f5f5f0", repeat: { count: 4, curve: 0.3 } }, { x: 0.05, y: 0.55, w: 0.9, h: 0.3 });
    expect(validateDesignAgainstTemplate(flower, TEMPLATE, CONTEXT)).toEqual([]);
    const wrongColour = withDecoration({ id: "flower", detail: "#123456" });
    expect(validateDesignAgainstTemplate(wrongColour, TEMPLATE, CONTEXT).map((i) => i.path)).toEqual(["layers.1.decoration.detail"]);
    const noDetail = withDecoration({ detail: "#f5f5f0" });
    expect(validateDesignAgainstTemplate(noDetail, TEMPLATE, CONTEXT).map((i) => i.message)).toEqual(["This decoration has no second color."]);
    // Out-of-range settings aren't a design at all.
    expect(designSpecSchema.safeParse(withDecoration({ repeat: { count: 30, curve: 0 } })).success).toBe(false);
    expect(designSpecSchema.safeParse(withDecoration({ outline: 40, style: "outline" })).success).toBe(false);
  });

  it("limits the motifs in one design, counting every repeat", () => {
    const spec = validSpec();
    const border = (id: string, y: number): DesignSpec["layers"][number] => ({
      id,
      areaId: "front-skirt",
      kind: "decoration",
      x: 0,
      y,
      w: 1,
      h: 0.1,
      rotation: 0,
      decoration: { id: "star", color: "#1b1b1b", repeat: { count: 24, curve: 0 } },
    });
    const many = { ...spec, layers: [...spec.layers, border("b1", 0), border("b2", 0.2), border("b3", 0.4), border("b4", 0.6)] };
    expect(validateDesignAgainstTemplate(many, TEMPLATE, CONTEXT).map((i) => i.path)).toContain("layers");
  });

  it("prices a border per motif and describes it for production", () => {
    const spec = withDecoration({ repeat: { count: 8, curve: 0.4 } }, { x: 0.05, y: 0.55, w: 0.9, h: 0.25 });
    const line = priceDesign(spec, TEMPLATE, 300_000).lines.find((l) => l.label.startsWith("Decoration"));
    expect(line).toEqual({ label: "Decoration × 8", amountMinor: 8 * TEMPLATE.addOns.decorationMinor });
    const name = (hex: string) => (hex === "#c9a227" ? "Gold" : hex === "#f5f5f0" ? "Ivory" : hex);
    expect(decorationDescription({ id: "flower", color: "#c9a227", detail: "#f5f5f0", repeat: { count: 12, curve: 0.5 }, style: "outline", mirror: true }, name)).toBe(
      "Flower × 12 border, curved down, Gold with Ivory detail, outline, mirrored",
    );
    expect(decorationDescription({ id: "heart", color: "#c9a227" }, name)).toBe("Heart decoration, Gold");
  });
});

describe("rendering customised decorations", () => {
  let assets: Assets;
  beforeAll(async () => {
    assets = storageAssets(await storageWithTemplateAssets());
  });

  it("plain decorations render exactly as before (same plan, no look)", () => {
    const op = normalizeForRender(validSpec(), TEMPLATE).front.areas.flatMap((a) => a.layers).find((l) => l.kind === "decoration");
    expect(op && "look" in op).toBe(false);
  });

  it("draws a border of repeats across its box in the preview", async () => {
    const spec = withDecoration({ repeat: { count: 5, curve: 0 } }, { x: 0, y: 0.55, w: 1, h: 0.3 });
    const plan = normalizeForRender(spec, TEMPLATE);
    const op = plan.front.areas.flatMap((a) => a.layers).find((l) => l.kind === "decoration");
    expect(op?.kind === "decoration" && op.repeat).toEqual({ count: 5, curve: 0 });
    const area = plan.front.areas.find((a) => a.areaId === "front-chest");
    if (!area) throw new Error("no area");
    const preview = await renderPreview(plan, "front", assets);
    const meta = await sharp(preview).metadata();
    const width = meta.width ?? 1200;
    const height = meta.height ?? 1560;
    // Along the border row, pink hearts appear in several separate places, not just one in the middle.
    const row = Math.round((area.rect.y + area.rect.h * 0.7) * height);
    const { data } = await sharp(preview)
      .extract({ left: Math.round(area.rect.x * width), top: row, width: Math.round(area.rect.w * width), height: 1 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    let runs = 0;
    let inside = false;
    for (let x = 0; x < data.length / 3; x += 1) {
      const pink = (data[x * 3] ?? 0) > 200 && (data[x * 3 + 1] ?? 0) < 190 && (data[x * 3 + 2] ?? 0) > 150;
      if (pink && !inside) runs += 1;
      inside = pink;
    }
    expect(runs).toBeGreaterThanOrEqual(4);
  });
});
