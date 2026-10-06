import sharp, { type OverlayOptions, type Sharp } from "sharp";

import { decorationSvg } from "@/lib/catalog/decorations";
import { patternSvg } from "@/lib/catalog/patterns";
import type { AreaPlan, LayerOp, RenderPlan, Side, SidePlan } from "@/lib/design/normalize";
import type { StorageAdapter } from "@/lib/storage/adapter";
import { BUCKETS } from "@/lib/storage/buckets";

import { loadFont } from "./fonts";
import { textToOutline } from "./text-outline";

// Server-side renderer. Input is always a normalized RenderPlan (lib/design/normalize.ts).
//
// Region recolor: color (or pattern) image whose alpha = the region mask, composited onto the
// garment with `multiply`, so the garment's own shading and folds show through the new color.
// Output PNGs are deterministic for the same plan + assets (no timestamps or random metadata).

export const PREVIEW_WIDTH = 1200;
export const PRINT_DPI = 300;
const CM_PER_INCH = 2.54;

export class RenderError extends Error {
  override readonly name = "RenderError";
}

/** Loads render inputs by storage key. Garments/masks come from product-media, uploads from design-assets. */
export function storageAssets(storage: StorageAdapter) {
  return {
    async product(key: string): Promise<Buffer> {
      const data = await storage.get(BUCKETS.productMedia, key);
      if (!data) {
        throw new RenderError("A template image is missing");
      }
      return data;
    },
    async upload(key: string): Promise<Buffer> {
      const data = await storage.get(BUCKETS.designAssets, key);
      if (!data) {
        throw new RenderError("An uploaded image is missing");
      }
      return data;
    },
  };
}

export type Assets = ReturnType<typeof storageAssets>;

const png = (image: Sharp) => image.png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();

// ─── layers ──────────────────────────────────────────────────────────────────

/** One layer as a transparent PNG of exactly boxW×boxH (before rotation). */
async function renderLayerBox(op: LayerOp, boxW: number, boxH: number, assets: Assets): Promise<Buffer> {
  switch (op.kind) {
    case "text": {
      const font = await loadFont(op.fontId);
      // Lay out at a fixed size, then scale the outline to fit the box (keeping proportions).
      const outline = textToOutline(font, op.content, 100);
      const width = Math.max(outline.width, 1);
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${boxW}" height="${boxH}" ` +
        `viewBox="0 0 ${width.toFixed(2)} ${outline.height.toFixed(2)}" preserveAspectRatio="xMidYMid meet">` +
        `<path d="${outline.d}" fill="${op.color}"/></svg>`;
      return png(sharp(Buffer.from(svg)).resize(boxW, boxH, { fit: "fill" }));
    }
    case "decoration": {
      const size = Math.min(boxW, boxH);
      const icon = await png(sharp(Buffer.from(decorationSvg(op.decorationId, op.color, size))));
      return png(
        sharp({ create: { width: boxW, height: boxH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([
          { input: icon, left: Math.floor((boxW - size) / 2), top: Math.floor((boxH - size) / 2) },
        ]),
      );
    }
    case "image": {
      const source = await assets.upload(op.assetKey);
      return png(
        sharp(source)
          .ensureAlpha()
          .resize(boxW, boxH, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }),
      );
    }
  }
}

/** Composite operations placing an area's layers onto a canvas region of areaW×areaH at (offsetX, offsetY). */
async function layerOverlays(
  area: AreaPlan,
  areaW: number,
  areaH: number,
  offsetX: number,
  offsetY: number,
  canvasW: number,
  canvasH: number,
  assets: Assets,
): Promise<OverlayOptions[]> {
  const overlays: OverlayOptions[] = [];
  for (const op of area.layers) {
    const boxW = Math.max(1, Math.round(op.w * areaW));
    const boxH = Math.max(1, Math.round(op.h * areaH));
    let image = await renderLayerBox(op, boxW, boxH, assets);
    let width = boxW;
    let height = boxH;
    if (op.rotation !== 0) {
      const rotated = await sharp(image)
        .rotate(op.rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer({ resolveWithObject: true });
      image = rotated.data;
      width = rotated.info.width;
      height = rotated.info.height;
    }
    const centreX = offsetX + (op.x + op.w / 2) * areaW;
    const centreY = offsetY + (op.y + op.h / 2) * areaH;
    let left = Math.round(centreX - width / 2);
    let top = Math.round(centreY - height / 2);
    // Validation keeps layers inside their area; clamp only to absorb rounding at the canvas edge.
    if (width > canvasW || height > canvasH) {
      image = await png(sharp(image).resize(Math.min(width, canvasW), Math.min(height, canvasH), { fit: "inside" }));
      const meta = await sharp(image).metadata();
      width = meta.width ?? width;
      height = meta.height ?? height;
    }
    left = Math.min(Math.max(left, 0), canvasW - width);
    top = Math.min(Math.max(top, 0), canvasH - height);
    overlays.push({ input: image, left, top });
  }
  return overlays;
}

// ─── garment ─────────────────────────────────────────────────────────────────

type Garment = { data: Buffer; width: number; height: number };

async function loadGarment(plan: SidePlan, assets: Assets, width: number): Promise<Garment> {
  if (!plan.garmentKey) {
    throw new RenderError(`This template has no ${plan.side} garment image`);
  }
  const { data, info } = await sharp(await assets.product(plan.garmentKey))
    .resize({ width })
    .removeAlpha()
    .png()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Mask as exactly one 8-bit channel per pixel (transparent = black = outside the region). */
async function maskRaw(maskKey: string, width: number, height: number, assets: Assets): Promise<Buffer> {
  return sharp(await assets.product(maskKey))
    .flatten({ background: "#000000" })
    .resize(width, height, { fit: "fill" })
    .greyscale()
    .extractChannel(0)
    .raw()
    .toBuffer();
}

/**
 * Interleaves an RGB raw buffer with a 1-channel alpha buffer into an RGBA PNG.
 * Done by hand: sharp's joinChannel is a no-op on generated (`create`) images.
 */
async function rgbaFrom(rgb: Buffer, alpha: Buffer, width: number, height: number): Promise<Buffer> {
  const pixels = width * height;
  if (rgb.length !== pixels * 3 || alpha.length !== pixels) {
    throw new RenderError("Image and mask sizes don't match");
  }
  const rgba = Buffer.alloc(pixels * 4);
  for (let i = 0; i < pixels; i += 1) {
    rgba[i * 4] = rgb[i * 3] ?? 0;
    rgba[i * 4 + 1] = rgb[i * 3 + 1] ?? 0;
    rgba[i * 4 + 2] = rgb[i * 3 + 2] ?? 0;
    rgba[i * 4 + 3] = alpha[i] ?? 0;
  }
  return png(sharp(rgba, { raw: { width, height, channels: 4 } }));
}

async function rawRgb(image: Sharp): Promise<Buffer> {
  return image.flatten({ background: "#ffffff" }).removeAlpha().raw().toBuffer();
}

async function regionOverlays(plan: SidePlan, garment: Garment, assets: Assets): Promise<OverlayOptions[]> {
  const { width, height } = garment;
  const overlays: OverlayOptions[] = [];
  for (const fill of plan.fills) {
    const mask = await maskRaw(fill.maskKey, width, height, assets);
    const paint = fill.pattern
      ? sharp(Buffer.from(patternSvg(fill.pattern.id, fill.pattern.color, fill.color, width, height, width / 16))).resize(width, height, { fit: "fill" })
      : sharp({ create: { width, height, channels: 3, background: fill.color } });
    const colored = await rgbaFrom(await rawRgb(paint), mask, width, height);
    overlays.push({ input: colored, blend: "multiply" });
  }
  return overlays;
}

/** Garment with region colors/patterns and the layers of every area on that side. */
async function composeSide(plan: SidePlan, assets: Assets, width: number): Promise<Garment> {
  const garment = await loadGarment(plan, assets, width);
  const overlays = await regionOverlays(plan, garment, assets);
  for (const area of plan.areas) {
    const areaW = area.rect.w * garment.width;
    const areaH = area.rect.h * garment.height;
    overlays.push(
      ...(await layerOverlays(area, areaW, areaH, area.rect.x * garment.width, area.rect.y * garment.height, garment.width, garment.height, assets)),
    );
  }
  const data = overlays.length > 0 ? await png(sharp(garment.data).composite(overlays)) : garment.data;
  return { data, width: garment.width, height: garment.height };
}

// ─── public API ──────────────────────────────────────────────────────────────

/** 1. Preview PNG of one side, PREVIEW_WIDTH px wide. */
export async function renderPreview(plan: RenderPlan, side: Side, assets: Assets, width = PREVIEW_WIDTH): Promise<Buffer> {
  return (await composeSide(plan[side], assets, width)).data;
}

/** 2. Flat front garment on a transparent background (for virtual try-on). Cut out by the union of region masks. */
export async function renderFlatGarment(plan: RenderPlan, assets: Assets, maskKeys: readonly string[], width = PREVIEW_WIDTH): Promise<Buffer> {
  if (maskKeys.length === 0) {
    throw new RenderError("The template has no region masks to cut the garment out with");
  }
  const composed = await composeSide(plan.front, assets, width);
  const { width: w, height: h } = composed;
  // Union of masks = per-pixel maximum.
  let union: Buffer | null = null;
  for (const key of maskKeys) {
    const mask = await maskRaw(key, w, h, assets);
    if (!union) {
      union = Buffer.from(mask);
    } else {
      for (let i = 0; i < union.length; i += 1) {
        union[i] = Math.max(union[i] ?? 0, mask[i] ?? 0);
      }
    }
  }
  if (!union) {
    throw new RenderError("No masks");
  }
  return rgbaFrom(await rawRgb(sharp(composed.data)), union, w, h);
}

export type PrintFile = { areaId: string; label: string; widthPx: number; heightPx: number; widthCm: number; heightCm: number; png: Buffer };

/** Pixel size of a print file for an area at PRINT_DPI. */
export function printPixels(widthCm: number, heightCm: number): { width: number; height: number } {
  return {
    width: Math.round((widthCm / CM_PER_INCH) * PRINT_DPI),
    height: Math.round((heightCm / CM_PER_INCH) * PRINT_DPI),
  };
}

/** 3. One transparent 300 DPI PNG per placement area that has layers. */
export async function renderPrintFiles(plan: RenderPlan, assets: Assets): Promise<PrintFile[]> {
  const files: PrintFile[] = [];
  for (const area of plan.printAreas) {
    const { width, height } = printPixels(area.widthCm, area.heightCm);
    const overlays = await layerOverlays(area, width, height, 0, 0, width, height, assets);
    const canvas = sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
    const data = await canvas.composite(overlays).withMetadata({ density: PRINT_DPI }).png({ compressionLevel: 9 }).toBuffer();
    files.push({ areaId: area.areaId, label: area.label, widthPx: width, heightPx: height, widthCm: area.widthCm, heightCm: area.heightCm, png: data });
  }
  return files;
}
