import sharp, { type OverlayOptions, type Sharp } from "sharp";

import { decorationLayerSvg, decorationSvg, repeatLayout, type DecorationId, type DecorationRepeat } from "@/lib/catalog/decorations";
import { FINISH_LABEL, finishTextureSvg, type Finish, type FinishId } from "@/lib/catalog/finishes";
import { patternSvg } from "@/lib/catalog/patterns";
import type { AreaPlan, LayerOp, RenderPlan, Side, SidePlan } from "@/lib/design/normalize";
import { applyFabricField, fabricField } from "@/lib/design/fabric-warp";
import { luminance, shadeChannel, shadeFactor, shadeRange } from "@/lib/design/shade";
import type { StorageAdapter } from "@/lib/storage/adapter";
import { BUCKETS } from "@/lib/storage/buckets";

import { loadFont } from "./fonts";
import { textToOutline } from "./text-outline";

// Server-side renderer. Input is always a normalized RenderPlan (lib/design/normalize.ts).
//
// Region recolor: color (or pattern) image whose alpha = the region mask, composited onto the garment.
// "multiply" (light drawings): the garment's own shading and folds show through the new color.
// "shade" (photos of any colour): the new colour is lit by the photo's own light and shadow (lib/design/shade.ts).
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
      if (op.look) {
        // Customised (second colour, outline, mirror or a border): drawn at the box's own size.
        return png(sharp(Buffer.from(decorationLayerSvg(op.decorationId, op.look, op.repeat, boxW, boxH))).resize(boxW, boxH, { fit: "fill" }));
      }
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
      if (op.repeat) {
        return imageBorder(source, op.repeat, op.mirror === true, boxW, boxH);
      }
      const image = sharp(source)
        .ensureAlpha()
        .resize(boxW, boxH, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } });
      return png(op.mirror ? image.flop() : image);
    }
  }
}

const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

/** An image repeated along a (curved) row, like a decoration border: same layout as decorationLayerSvg. */
async function imageBorder(source: Buffer, repeat: DecorationRepeat, mirror: boolean, boxW: number, boxH: number): Promise<Buffer> {
  const places = repeatLayout(repeat.count, repeat.curve, boxW, boxH);
  const size = Math.max(1, Math.round(places[0]?.size ?? 1));
  let motif = sharp(source).ensureAlpha().resize(size, size, { fit: "contain", background: CLEAR });
  if (mirror) motif = motif.flop();
  const one = await png(motif);
  // Drawn on a canvas with a margin (rotated motifs can reach past the box), then cut to the box.
  const pad = size;
  const overlays: OverlayOptions[] = [];
  for (const p of places) {
    const angle = Math.round(p.angle * 10) / 10;
    const turned = angle === 0 ? { data: one, info: { width: size, height: size } } : await sharp(one).rotate(angle, { background: CLEAR }).png().toBuffer({ resolveWithObject: true });
    overlays.push({ input: turned.data, left: Math.round(pad + p.x - turned.info.width / 2), top: Math.round(pad + p.y - turned.info.height / 2) });
  }
  const canvas = await png(sharp({ create: { width: boxW + 2 * pad, height: boxH + 2 * pad, channels: 4, background: CLEAR } }).composite(overlays));
  return png(sharp(canvas).extract({ left: pad, top: pad, width: boxW, height: boxH }));
}

/**
 * How an embroidered or sequinned item looks in a preview: the finish's texture laid over the item
 * (only where it's drawn), and a soft shadow because it stands up from the fabric.
 */
async function withFinish(image: Buffer, finish: FinishId, boxW: number, boxH: number, pxPerCm: number): Promise<Buffer> {
  const texture = await png(sharp(Buffer.from(finishTextureSvg(finish, boxW, boxH, pxPerCm))).resize(boxW, boxH, { fit: "fill" }));
  const textured = await png(sharp(image).composite([{ input: texture, blend: "atop" }]));
  const alpha = await sharp(image).ensureAlpha().extractChannel(3).raw().toBuffer();
  const shadowAlpha = Buffer.from(alpha.map((a) => Math.round(a * 0.45)));
  const shadow = await png(sharp(await rgbaFrom(Buffer.alloc(boxW * boxH * 3), shadowAlpha, boxW, boxH)).blur(Math.max(0.6, pxPerCm * 0.05)));
  const offset = Math.max(1, Math.round(pxPerCm * 0.04));
  return png(
    sharp({ create: { width: boxW, height: boxH, channels: 4, background: CLEAR } }).composite([
      { input: shadow, left: offset, top: offset },
      { input: textured, left: 0, top: 0 },
    ]),
  );
}

/**
 * Composite operations placing an area's layers onto a canvas region of areaW×areaH at (offsetX, offsetY).
 * `finishes: "look"` draws embroidery/sequins as they'll look (previews); "flat" draws only the artwork
 * (production files). `only` keeps the layers of one finish.
 */
async function layerOverlays(
  area: AreaPlan,
  areaW: number,
  areaH: number,
  offsetX: number,
  offsetY: number,
  canvasW: number,
  canvasH: number,
  assets: Assets,
  options: { finishes: "look" | "flat"; only?: Finish } = { finishes: "look" },
): Promise<OverlayOptions[]> {
  const overlays: OverlayOptions[] = [];
  const pxPerCm = areaW / Math.max(0.1, area.widthCm);
  for (const op of area.layers) {
    if (options.only && (op.finish ?? "print") !== options.only) continue;
    const boxW = Math.max(1, Math.round(op.w * areaW));
    const boxH = Math.max(1, Math.round(op.h * areaH));
    let image = await renderLayerBox(op, boxW, boxH, assets);
    if (op.finish && options.finishes === "look") {
      image = await withFinish(image, op.finish, boxW, boxH, pxPerCm);
    }
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

// ─── all-over prints ─────────────────────────────────────────────────────────

/** Share of a print tile the motif fills; the rest is the gap between repeats. */
const PRINT_MOTIF = 0.7;

/** One repeat of an all-over print: the motif centred on a transparent size×size square. */
async function printTile(
  print: { kind: "image"; assetKey: string } | { kind: "decoration"; decorationId: DecorationId; color: string },
  size: number,
  assets: Assets,
): Promise<Buffer> {
  const motif = Math.max(4, Math.round(size * PRINT_MOTIF));
  const art =
    print.kind === "decoration"
      ? await png(sharp(Buffer.from(decorationSvg(print.decorationId, print.color, motif))))
      : await png(sharp(await assets.upload(print.assetKey)).ensureAlpha().resize(motif, motif, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }));
  return png(sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: art, gravity: "center" }]));
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

async function regionOverlays(plan: SidePlan, garment: Garment, assets: Assets, recolor: RenderPlan["recolor"]): Promise<OverlayOptions[]> {
  const { width, height } = garment;
  const overlays: OverlayOptions[] = [];
  const garmentRgb = recolor === "shade" && plan.fills.length > 0 ? await rawRgb(sharp(garment.data)) : null;
  for (const fill of plan.fills) {
    const mask = await maskRaw(fill.maskKey, width, height, assets);
    let paintImage: Sharp;
    if (fill.print) {
      // All-over print: the motif repeated across the part, over its base colour.
      const tile = await printTile(fill.print, Math.max(8, Math.round(fill.print.tile * width)), assets);
      paintImage = sharp(await png(sharp({ create: { width, height, channels: 3, background: fill.color } }).composite([{ input: tile, tile: true, left: 0, top: 0 }])));
    } else if (fill.pattern) {
      paintImage = sharp(Buffer.from(patternSvg(fill.pattern.id, fill.pattern.color, fill.color, width, height, width / 16))).resize(width, height, { fit: "fill" });
    } else {
      paintImage = sharp({ create: { width, height, channels: 3, background: fill.color } });
    }
    const paint = await rawRgb(paintImage);
    if (garmentRgb) {
      const range = shadeRange(garmentRgb, 3, mask, 1);
      for (let p = 0; p < width * height; p += 1) {
        const i = p * 3;
        const factor = shadeFactor(luminance(garmentRgb[i] ?? 0, garmentRgb[i + 1] ?? 0, garmentRgb[i + 2] ?? 0), range);
        for (let k = 0; k < 3; k += 1) paint[i + k] = shadeChannel(paint[i + k] ?? 0, factor);
      }
      overlays.push({ input: await rgbaFrom(paint, mask, width, height) });
    } else {
      overlays.push({ input: await rgbaFrom(paint, mask, width, height), blend: "multiply" });
    }
  }
  return overlays;
}

/** Union of masks (per-pixel maximum), one 8-bit channel at width×height. */
async function unionMask(keys: readonly string[], width: number, height: number, assets: Assets): Promise<Buffer> {
  let union: Buffer | null = null;
  for (const key of keys) {
    const mask = await maskRaw(key, width, height, assets);
    if (!union) {
      union = Buffer.from(mask);
    } else {
      for (let i = 0; i < union.length; i += 1) union[i] = Math.max(union[i] ?? 0, mask[i] ?? 0);
    }
  }
  if (!union) throw new RenderError("No masks");
  return union;
}

/** Composites `overlays` onto a transparent width×height canvas, keeping only what lies on the mask. */
async function trimmed(overlays: OverlayOptions[], mask: Buffer, width: number, height: number): Promise<Buffer> {
  const layered = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(overlays)
    .raw()
    .toBuffer();
  for (let p = 0; p < width * height; p += 1) {
    layered[p * 4 + 3] = Math.round(((layered[p * 4 + 3] ?? 0) * (mask[p] ?? 0)) / 255);
  }
  return png(sharp(layered, { raw: { width, height, channels: 4 } }));
}

/** Flat RGBA (width×height) of overlays composited on a transparent canvas. */
async function flatLayers(overlays: OverlayOptions[], width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(overlays).raw().toBuffer();
}

/** Garment with region colors/patterns and the layers of every area on that side. */
async function composeSide(plan: SidePlan, assets: Assets, width: number, recolor: RenderPlan["recolor"]): Promise<Garment> {
  const garment = await loadGarment(plan, assets, width);
  const overlays = await regionOverlays(plan, garment, assets, recolor);
  const { width: w, height: h } = garment;
  const free: OverlayOptions[] = [];
  const trimmedLayers: OverlayOptions[] = [];
  let trimKeys: string[] = [];
  for (const area of plan.areas) {
    const layers = await layerOverlays(area, area.rect.w * w, area.rect.h * h, area.rect.x * w, area.rect.y * h, w, h, assets);
    if (area.clipToFabric && area.fabricMaskKeys.length > 0) {
      trimmedLayers.push(...layers);
      trimKeys = area.fabricMaskKeys;
    } else {
      free.push(...layers);
    }
  }
  if (free.length + trimmedLayers.length > 0) {
    // Items take the fabric's shape and shading (lib/design/fabric-warp.ts) inside the garment's outline.
    const outline = plan.outlineMaskKeys.length > 0 ? await unionMask(plan.outlineMaskKeys, w, h, assets) : Buffer.alloc(w * h);
    const field = fabricField(await rawRgb(sharp(garment.data)), 3, outline, 1, w, h);
    const shaped = async (layers: OverlayOptions[]) => {
      const out = Buffer.alloc(w * h * 4);
      applyFabricField(await flatLayers(layers, w, h), out, field);
      return out;
    };
    if (free.length > 0) overlays.push({ input: await png(sharp(await shaped(free), { raw: { width: w, height: h, channels: 4 } })) });
    if (trimmedLayers.length > 0) {
      // Whatever hangs off the garment's outline is trimmed away.
      const shapedTrimmed = await shaped(trimmedLayers);
      const mask = await unionMask(trimKeys, w, h, assets);
      for (let p = 0; p < w * h; p += 1) shapedTrimmed[p * 4 + 3] = Math.round(((shapedTrimmed[p * 4 + 3] ?? 0) * (mask[p] ?? 0)) / 255);
      overlays.push({ input: await png(sharp(shapedTrimmed, { raw: { width: w, height: h, channels: 4 } })) });
    }
  }
  const data = overlays.length > 0 ? await png(sharp(garment.data).composite(overlays)) : garment.data;
  return { data, width: w, height: h };
}

// ─── public API ──────────────────────────────────────────────────────────────

/** 1. Preview PNG of one side, PREVIEW_WIDTH px wide. */
export async function renderPreview(plan: RenderPlan, side: Side, assets: Assets, width = PREVIEW_WIDTH): Promise<Buffer> {
  return (await composeSide(plan[side], assets, width, plan.recolor)).data;
}

/** 2. Flat front garment on a transparent background (for virtual try-on). Cut out by the union of region masks. */
export async function renderFlatGarment(plan: RenderPlan, assets: Assets, maskKeys: readonly string[], width = PREVIEW_WIDTH): Promise<Buffer> {
  if (maskKeys.length === 0) {
    throw new RenderError("The template has no region masks to cut the garment out with");
  }
  const composed = await composeSide(plan.front, assets, width, plan.recolor);
  const { width: w, height: h } = composed;
  return rgbaFrom(await rawRgb(sharp(composed.data)), await unionMask(maskKeys, w, h, assets), w, h);
}

export type PrintFile = { areaId: string; label: string; widthPx: number; heightPx: number; widthCm: number; heightCm: number; png: Buffer };

/** Longest side of a print file; a whole-front area at 300 DPI would be far too large to render. */
export const MAX_PRINT_SIDE = 6000;

/** Pixel size and DPI of a print file: PRINT_DPI, lowered for large areas to keep within MAX_PRINT_SIDE. */
export function printPixels(widthCm: number, heightCm: number): { width: number; height: number; dpi: number } {
  const dpi = Math.min(PRINT_DPI, Math.floor((MAX_PRINT_SIDE * CM_PER_INCH) / Math.max(widthCm, heightCm)));
  return {
    width: Math.round((widthCm / CM_PER_INCH) * dpi),
    height: Math.round((heightCm / CM_PER_INCH) * dpi),
    dpi,
  };
}

/** Width of the garment outline used to trim print files (cropped to the area, then scaled up). */
const OUTLINE_WIDTH = 1200;

/**
 * 3. One transparent PNG per placement area with printed items (300 DPI, less for very large areas), and
 * one placement file per area and finish for embroidered or sequinned items (the artwork at real size,
 * for the embroidery or sequin work; labelled with the finish).
 */
export async function renderPrintFiles(plan: RenderPlan, assets: Assets): Promise<PrintFile[]> {
  const files: PrintFile[] = [];
  const jobs = plan.printAreas.flatMap((area) =>
    (["print", "embroidery", "sequins"] as const)
      .filter((finish) => area.layers.some((l) => (l.finish ?? "print") === finish))
      .map((finish) => ({ area, finish })),
  );
  for (const { area, finish } of jobs) {
    const { width, height, dpi } = printPixels(area.widthCm, area.heightCm);
    const overlays = await layerOverlays(area, width, height, 0, 0, width, height, assets, { finishes: "flat", only: finish });
    let data: Buffer;
    if (area.clipToFabric && area.fabricMaskKeys.length > 0) {
      // The garment outline inside the area, at print size: only what lands on fabric is printed.
      const outlineH = Math.round((OUTLINE_WIDTH * 13) / 10);
      const outline = await unionMask(area.fabricMaskKeys, OUTLINE_WIDTH, outlineH, assets);
      const left = Math.round(area.rect.x * OUTLINE_WIDTH);
      const top = Math.round(area.rect.y * outlineH);
      const crop = {
        left,
        top,
        width: Math.max(1, Math.min(OUTLINE_WIDTH - left, Math.round(area.rect.w * OUTLINE_WIDTH))),
        height: Math.max(1, Math.min(outlineH - top, Math.round(area.rect.h * outlineH))),
      };
      const mask = await sharp(outline, { raw: { width: OUTLINE_WIDTH, height: outlineH, channels: 1 } })
        .extract(crop)
        .resize(width, height, { fit: "fill" })
        .extractChannel(0)
        .raw()
        .toBuffer();
      data = await sharp(await trimmed(overlays, mask, width, height)).withMetadata({ density: dpi }).png({ compressionLevel: 9 }).toBuffer();
    } else {
      const canvas = sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
      data = await canvas.composite(overlays).withMetadata({ density: dpi }).png({ compressionLevel: 9 }).toBuffer();
    }
    // Printed items keep the area's own id and label, as before finishes existed.
    const areaId = finish === "print" ? area.areaId : `${area.areaId}-${finish}`;
    const label = finish === "print" ? area.label : `${area.label}: ${FINISH_LABEL[finish].toLowerCase()} placement`;
    files.push({ areaId, label, widthPx: width, heightPx: height, widthCm: area.widthCm, heightCm: area.heightCm, png: data });
  }
  // All-over prints: one repeat at real size; the print shop repeats it across the part's fabric.
  for (const tile of plan.printTiles) {
    const { width, dpi } = printPixels(tile.tileCm, tile.tileCm);
    const data = await sharp(await printTile(tile, width, assets)).withMetadata({ density: dpi }).png({ compressionLevel: 9 }).toBuffer();
    files.push({ areaId: `print-${tile.regionId}`, label: `${tile.label} (repeats every ${tile.tileCm} cm)`, widthPx: width, heightPx: width, widthCm: tile.tileCm, heightCm: tile.tileCm, png: data });
  }
  return files;
}
