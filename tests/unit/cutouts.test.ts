import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { cutOutDecoration, CutoutError, fillHoles, labToHex, hexToLab } from "@/lib/cutouts/extract";
import { cutoutInputSchema, printDpi, PRINTABLE_DPI } from "@/lib/cutouts/rules";
import { normalizeForRender } from "@/lib/design/normalize";
import { priceDesign } from "@/lib/design/pricing";
import { isCutoutKey, validateDesignAgainstTemplate } from "@/lib/design/validate";
import { imageDescription } from "@/lib/production/spec-data";
import { renderPreview, storageAssets } from "@/lib/renderer/render";
import { BUCKETS } from "@/lib/storage/buckets";
import type { DesignSpec } from "@/types/design-spec";

import { DECORATED_BOX, decoratedPhoto as photo } from "../fixtures/cutout-photo";
import { CONTEXT, CUSTOMER_ID, KEYS, storageWithTemplateAssets, TEMPLATE, validSpec } from "../fixtures/design";

// Decorations taken from other dresses: cutting them out of a product photo, and using them in a
// design (priced and described like decorations, mirrored or repeated as a border).

async function pixels(webp: Buffer) {
  const { data, info } = await sharp(webp).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const opaque: [number, number, number][] = [];
  for (let i = 0; i < info.width * info.height; i += 1) {
    if ((data[i * 4 + 3] ?? 0) >= 128) opaque.push([data[i * 4] ?? 0, data[i * 4 + 1] ?? 0, data[i * 4 + 2] ?? 0]);
  }
  return { opaque, width: info.width, height: info.height };
}

const near = (p: [number, number, number], q: [number, number, number], tolerance: number) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < tolerance;

describe("cutting a decoration out of a product photo", () => {
  it("removes the fabric and keeps the decoration, with its main colours", async () => {
    const cut = await cutOutDecoration(await photo(), DECORATED_BOX, 0.4);
    // The diamond is 67 px across; the cut-out is cropped to it (plus a small margin).
    expect(cut.width).toBeGreaterThan(60);
    expect(cut.width).toBeLessThan(80);
    const { opaque } = await pixels(cut.data);
    expect(opaque.some((p) => near(p, [200, 30, 45], 30))).toBe(true);
    expect(opaque.filter((p) => near(p, [28, 42, 92], 30)).length).toBeLessThan(opaque.length * 0.05);
    expect(cut.palette.map(hexToLab).some((lab) => lab[1] > 40)).toBe(true); // a red
  });

  it("drops the backdrop without erasing stitches as pale as it", async () => {
    // The box reaches off the garment onto the backdrop (on the right, past x = 300).
    const cut = await cutOutDecoration(await photo(), { x: 0.53, y: 0.38, w: 0.42, h: 0.24 }, 0.4);
    const { opaque } = await pixels(cut.data);
    expect(cut.width).toBeLessThan(90); // the backdrop strip on the left is gone
    expect(opaque.filter((p) => near(p, [246, 246, 244], 20)).length).toBeGreaterThan(20); // the stitches stay
  });

  it("swaps a main colour for another, keeping the rest", async () => {
    const source = await photo();
    const box = DECORATED_BOX;
    const first = await cutOutDecoration(source, box, 0.4);
    const red = first.palette.findIndex((hex) => hexToLab(hex)[1] > 40);
    const swaps = first.palette.map((_, i) => (i === red ? "#c9a227" : null));
    const again = await cutOutDecoration(source, box, 0.4, swaps);
    expect(again.palette).toEqual(first.palette); // the same palette, so swaps stay in step
    const { opaque } = await pixels(again.data);
    expect(opaque.some((p) => near(p, [201, 162, 39], 40))).toBe(true);
    expect(opaque.some((p) => near(p, [200, 30, 45], 30))).toBe(false);
  });

  it("refuses boxes with nothing in them, or too small to use", async () => {
    await expect(cutOutDecoration(await photo(), { x: 0.27, y: 0.75, w: 0.2, h: 0.15 }, 0.4)).rejects.toMatchObject({ code: "EMPTY" });
    await expect(cutOutDecoration(await photo(), { x: 0.5, y: 0.5, w: 0.03, h: 0.03 }, 0.4)).rejects.toBeInstanceOf(CutoutError);
  });

  it("fills holes in the garment outline (decorations aren't backdrop)", () => {
    const mask = { width: 5, height: 5, data: Uint8Array.from([0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 1, 0, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0]) };
    expect(fillHoles(mask).data[12]).toBe(1);
    expect(fillHoles(mask).data[0]).toBe(0);
    expect(labToHex(hexToLab("#c9a227"))).toBe("#c9a227");
  });

  it("checks the request", () => {
    const ok = { productId: CONTEXT.productId, imageIndex: 0, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, strength: 0.4, designProductId: CONTEXT.productId };
    expect(cutoutInputSchema.safeParse(ok).success).toBe(true);
    expect(cutoutInputSchema.safeParse({ ...ok, box: { x: 0.9, y: 0.1, w: 0.2, h: 0.2 } }).success).toBe(false);
    expect(cutoutInputSchema.safeParse({ ...ok, swaps: ["red"] }).success).toBe(false);
    expect(cutoutInputSchema.safeParse({ ...ok, swaps: [null, null, null, null, null] }).success).toBe(false);
  });
});

const CUTOUT_KEY = `${CUSTOMER_ID}/cutouts/12345678-2222-4111-8111-111111111111.webp`;

/** The fixture design with an image layer (a cut-out unless `key` says otherwise) instead of the heart. */
function withImage(image: Partial<Extract<DesignSpec["layers"][number], { kind: "image" }>["image"]> = {}, key = CUTOUT_KEY): DesignSpec {
  const spec = validSpec();
  return {
    ...spec,
    layers: spec.layers.map((l) =>
      l.kind === "decoration" ? { id: l.id, areaId: l.areaId, kind: "image" as const, x: 0, y: 0.55, w: 1, h: 0.3, rotation: 0, image: { assetKey: key, ...image } } : l,
    ),
  };
}

describe("cut-outs in a design", () => {
  it("are the customer's own images, priced per motif like decorations", () => {
    expect(isCutoutKey(CUTOUT_KEY)).toBe(true);
    expect(isCutoutKey(KEYS.upload)).toBe(false);
    expect(validateDesignAgainstTemplate(withImage({ mirror: true, repeat: { count: 5, curve: 0.3 } }), TEMPLATE, CONTEXT)).toEqual([]);
    const someoneElses = withImage({}, "9b6c7d8e-2222-4333-8444-555566667777/cutouts/12345678-2222-4111-8111-111111111111.webp");
    expect(validateDesignAgainstTemplate(someoneElses, TEMPLATE, CONTEXT).map((i) => i.message)).toEqual(["That image isn't one of your uploads."]);

    const border = priceDesign(withImage({ repeat: { count: 5, curve: 0 } }), TEMPLATE, 300_000).lines;
    expect(border.find((l) => l.label.startsWith("Decoration"))).toEqual({ label: "Decoration × 5", amountMinor: 5 * TEMPLATE.addOns.decorationMinor });
    expect(border.find((l) => l.label.startsWith("Image"))).toBeUndefined();
    // The customer's own image repeated as a border is priced per image.
    const upload = priceDesign(withImage({ repeat: { count: 3, curve: 0 } }, KEYS.upload), TEMPLATE, 300_000).lines;
    expect(upload.find((l) => l.label.startsWith("Image"))).toEqual({ label: "Image × 3", amountMinor: 3 * TEMPLATE.addOns.imageMinor });
  });

  it("names the source dress for production, and marks coarse ones as a reference", () => {
    const area = { widthCm: 20, heightCm: 15 };
    const layer = { w: 0.5, h: 0.5, image: {} };
    // 10 × 7.5 cm box: 600 px is about 200 dpi; 150 px about 50 dpi.
    expect(imageDescription(layer, { productName: "Embroidered Kurti Dress", width: 600, height: 400 }, area)).toBe('Decoration taken from "Embroidered Kurti Dress", see print file');
    expect(imageDescription({ ...layer, image: { mirror: true, repeat: { count: 6, curve: 0.5 } } }, { productName: "Embroidered Kurti Dress", width: 150, height: 100 }, area)).toMatch(
      /^Decoration taken from "Embroidered Kurti Dress", × 6 border, curved down, mirrored, reference only \(\d+ dpi\): recreate it from the original dress, don't print$/,
    );
    expect(imageDescription(layer, null, area)).toBe("Customer image, see print file");
    expect(printDpi({ width: 600, height: 400 }, { width: 10, height: 7.5 })).toBeGreaterThanOrEqual(PRINTABLE_DPI);
  });

  it("render mirrored and as a border; plain images keep their old plan", async () => {
    const plain = normalizeForRender(withImage({}, KEYS.upload), TEMPLATE).front.areas.flatMap((a) => a.layers).find((l) => l.kind === "image");
    expect(plain && ("mirror" in plain || "repeat" in plain)).toBe(false);

    const storage = await storageWithTemplateAssets();
    // An asymmetric motif: red on the left half only.
    const motif = Buffer.alloc(40 * 40 * 4);
    for (let i = 0; i < 40 * 40; i += 1) motif.set(i % 40 < 20 ? [220, 20, 40, 255] : [0, 0, 0, 0], i * 4);
    await storage.put(BUCKETS.designAssets, CUTOUT_KEY, await sharp(motif, { raw: { width: 40, height: 40, channels: 4 } }).webp({ lossless: true }).toBuffer(), "image/webp");
    const assets = storageAssets(storage);

    /** Red runs along a row across the area; `span` limits it to part of the area (fractions). */
    async function redRuns(spec: DesignSpec, span = { from: 0, to: 1 }) {
      const plan = normalizeForRender(spec, TEMPLATE);
      const area = plan.front.areas.find((a) => a.areaId === "front-chest");
      if (!area) throw new Error("no area");
      const preview = await renderPreview(plan, "front", assets);
      const meta = await sharp(preview).metadata();
      const width = meta.width ?? 1200;
      const height = meta.height ?? 1560;
      const row = Math.round((area.rect.y + area.rect.h * 0.7) * height);
      const left = Math.round((area.rect.x + area.rect.w * span.from) * width);
      const { data } = await sharp(preview)
        .extract({ left, top: row, width: Math.round(area.rect.w * (span.to - span.from) * width), height: 1 })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const runs: number[] = [];
      let inside = false;
      for (let x = 0; x < data.length / 3; x += 1) {
        const red = (data[x * 3] ?? 0) > 180 && (data[x * 3 + 1] ?? 0) < 90;
        if (red && !inside) runs.push(x);
        inside = red;
      }
      return runs;
    }
    expect((await redRuns(withImage({ repeat: { count: 5, curve: 0 } }))).length).toBeGreaterThanOrEqual(4);
    // Mirrored, the red half moves from the left of the box to the right.
    const single = { x: 0.35, w: 0.3 };
    const span = { from: single.x, to: single.x + single.w };
    const straight = await redRuns({ ...withImage(), layers: withImage().layers.map((l) => (l.kind === "image" ? { ...l, ...single } : l)) }, span);
    const mirrored = await redRuns({ ...withImage({ mirror: true }), layers: withImage({ mirror: true }).layers.map((l) => (l.kind === "image" ? { ...l, ...single } : l)) }, span);
    expect(straight[0]).toBeDefined();
    expect(mirrored[0] ?? 0).toBeGreaterThan((straight[0] ?? 0) + 10);
  });
});
