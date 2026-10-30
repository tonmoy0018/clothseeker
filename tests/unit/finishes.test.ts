import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";

import { finishesFor, finishTextureSvg } from "@/lib/catalog/finishes";
import { normalizeForRender } from "@/lib/design/normalize";
import { priceDesign } from "@/lib/design/pricing";
import { validateDesignAgainstTemplate } from "@/lib/design/validate";
import { renderPreview, renderPrintFiles, storageAssets, type Assets } from "@/lib/renderer/render";
import type { DesignSpec } from "@/types/design-spec";
import type { TemplateConfig } from "@/types/template";

import { CONTEXT, CUSTOMER_ID, KEYS, storageWithTemplateAssets, TEMPLATE, validSpec } from "../fixtures/design";

// Finishes: an item printed (default), embroidered or sequinned, each with its own price per item
// (per motif in a border), shown textured in previews and given its own production placement file.

type Layer = DesignSpec["layers"][number];

/** The fixture design (text t1 + heart d1 on the chest) with some layers changed. */
function withLayers(change: (layer: Layer) => Layer): DesignSpec {
  const spec = validSpec();
  return { ...spec, layers: spec.layers.map(change) };
}
const embroideredHeart = (repeat?: { count: number; curve: number }) =>
  withLayers((l) => (l.kind === "decoration" ? { ...l, finish: "embroidery", decoration: { ...l.decoration, ...(repeat ? { repeat } : {}) } } : l));

describe("which items can have which finish", () => {
  it("lets text be embroidered, decorations and cut-outs also sequinned, and keeps photos printed", () => {
    expect(finishesFor("text")).toEqual(["print", "embroidery"]);
    expect(finishesFor("cutout")).toEqual(["print", "embroidery", "sequins"]);
    expect(finishesFor("image")).toEqual(["print"]);

    expect(validateDesignAgainstTemplate(embroideredHeart(), TEMPLATE, CONTEXT)).toEqual([]);
    const sequinText = withLayers((l) => (l.kind === "text" ? { ...l, finish: "sequins" } : l));
    expect(validateDesignAgainstTemplate(sequinText, TEMPLATE, CONTEXT).map((i) => i.message)).toEqual(["This item can't be made with sequins."]);
    const photo = withLayers((l) => (l.kind === "decoration" ? { id: l.id, areaId: l.areaId, kind: "image", x: l.x, y: l.y, w: l.w, h: l.h, rotation: 0, finish: "embroidery", image: { assetKey: KEYS.upload } } : l));
    expect(validateDesignAgainstTemplate(photo, TEMPLATE, CONTEXT).map((i) => i.path)).toEqual(["layers.1.finish"]);
    const cutout = withLayers((l) =>
      l.kind === "decoration"
        ? { id: l.id, areaId: l.areaId, kind: "image", x: l.x, y: l.y, w: l.w, h: l.h, rotation: 0, finish: "sequins", image: { assetKey: `${CUSTOMER_ID}/cutouts/12345678-2222-4111-8111-111111111111.webp` } }
        : l,
    );
    expect(validateDesignAgainstTemplate(cutout, TEMPLATE, CONTEXT)).toEqual([]);
  });

  it("refuses a finish the garment doesn't offer", () => {
    const noEmbroidery: TemplateConfig = { ...TEMPLATE, finishes: { embroidery: null, sequins: 35_000 } };
    expect(validateDesignAgainstTemplate(embroideredHeart(), noEmbroidery, CONTEXT).map((i) => i.message)).toEqual(["Embroidery isn't available on this dress."]);
  });
});

describe("pricing finishes", () => {
  it("charges the finish's own price per item, instead of the print price", () => {
    const lines = priceDesign(embroideredHeart({ count: 5, curve: 0 }), TEMPLATE, 300_000).lines;
    expect(lines).toContainEqual({ label: "Embroidery × 5", amountMinor: 5 * (TEMPLATE.finishes.embroidery ?? 0) });
    expect(lines.find((l) => l.label.startsWith("Decoration"))).toBeUndefined();
    expect(lines).toContainEqual({ label: "Text", amountMinor: TEMPLATE.addOns.textMinor });

    const embroideredText = withLayers((l) => (l.kind === "text" ? { ...l, finish: "embroidery" } : l));
    const textLines = priceDesign(embroideredText, TEMPLATE, 300_000).lines;
    expect(textLines).toContainEqual({ label: "Embroidery", amountMinor: TEMPLATE.finishes.embroidery ?? 0 });
    expect(textLines.find((l) => l.label === "Text")).toBeUndefined();
  });
});

describe("drawing finishes", () => {
  let assets: Assets;
  beforeAll(async () => {
    assets = storageAssets(await storageWithTemplateAssets());
  });

  it("leaves printed items' plan unchanged and carries the finish otherwise", () => {
    const plain = normalizeForRender(validSpec(), TEMPLATE).front.areas.flatMap((a) => a.layers);
    expect(plain.some((l) => "finish" in l)).toBe(false);
    const finished = normalizeForRender(embroideredHeart(), TEMPLATE).front.areas.flatMap((a) => a.layers);
    expect(finished.find((l) => l.kind === "decoration")?.finish).toBe("embroidery");
    expect(finishTextureSvg("sequins", 100, 50, 40)).toBe(finishTextureSvg("sequins", 100, 50, 40));
    expect(finishTextureSvg("embroidery", 100, 50, 40)).toContain("<pattern");
  });

  it("textures the item in the preview", async () => {
    /** Pixel-to-pixel roughness inside the heart: a print is smooth (only the fabric's soft shading), stitches aren't. */
    async function heartRoughness(spec: DesignSpec) {
      const plan = normalizeForRender(spec, TEMPLATE);
      const area = plan.front.areas.find((a) => a.areaId === "front-chest");
      const op = area?.layers.find((l) => l.kind === "decoration");
      if (!area || !op) throw new Error("no heart");
      const preview = await renderPreview(plan, "front", assets);
      const meta = await sharp(preview).metadata();
      const width = meta.width ?? 1200;
      const height = meta.height ?? 1560;
      const cx = (area.rect.x + area.rect.w * (op.x + op.w / 2)) * width;
      const cy = (area.rect.y + area.rect.h * (op.y + op.h / 2)) * height;
      const { data } = await sharp(preview)
        .extract({ left: Math.round(cx - 6), top: Math.round(cy - 6), width: 12, height: 12 })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      let sum = 0;
      for (let y = 0; y < 12; y += 1) {
        for (let x = 0; x < 11; x += 1) sum += Math.abs((data[(y * 12 + x) * 3] ?? 0) - (data[(y * 12 + x + 1) * 3] ?? 0));
      }
      return sum / (12 * 11);
    }
    expect(await heartRoughness(embroideredHeart())).toBeGreaterThan((await heartRoughness(validSpec())) * 2);
  });

  it("gives embroidered items their own placement file, keeping the print file for the rest", async () => {
    const files = await renderPrintFiles(normalizeForRender(embroideredHeart(), TEMPLATE), assets);
    const chest = files.filter((f) => f.areaId.startsWith("front-chest"));
    expect(chest.map((f) => [f.areaId, f.label])).toEqual([
      ["front-chest", "Front chest"],
      ["front-chest-embroidery", "Front chest: embroidery placement"],
    ]);
    // Placement files are the flat artwork at real size: no stitch texture or shadow.
    const placement = chest[1];
    if (!placement) throw new Error("no placement file");
    const meta = await sharp(placement.png).metadata();
    expect(meta.width).toBe(placement.widthPx);
  });
});
