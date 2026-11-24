import sharp from "sharp";

import { readRgb } from "@/lib/garment-photo/align";
import { findGarment, SegmentationError, toLab, type Mask, type RgbImage } from "@/lib/garment-photo/segment";

// Cutting a decoration (embroidery, a lace patch, a print) out of a box on a ClothSeeker product photo.
//
// The fabric is learned from the box's own edges: the customer draws the box around the decoration, so
// its edges are mostly the cloth behind it. Pixels close to those colours are keyed out, more of them as
// `strength` rises; lightness counts for less than tint, so folds and shading of the cloth go too. The
// garment finder (lib/garment-photo) removes the mannequin and backdrop, and keeps them out of the
// fabric colours (a white mannequin would otherwise remove white stitches). When it can't find the
// garment, the colours alone decide. Small specks are dropped and the result is cropped to what's left.
// Pure functions over raw pixels; `cutOutDecoration` is the sharp wrapper.

export type Box = { x: number; y: number; w: number; h: number };
export type Lab = [number, number, number];

export class CutoutError extends Error {
  override readonly name = "CutoutError";

  constructor(
    readonly code: "TOO_SMALL" | "EMPTY",
    message: string,
  ) {
    super(message);
  }
}

/** Smallest box side, in photo pixels. */
export const MIN_BOX_PX = 24;
/** Cut-outs are worked on at most this size (long side). */
const MAX_WORK_PX = 1200;
export const MAX_PALETTE = 4;

/** Key-out threshold (Lab distance) for a strength 0…1. */
export function keyThreshold(strength: number): number {
  return 6 + Math.min(1, Math.max(0, strength)) * 30;
}

/** Lab distance with lightness weighted down, so shading of one colour stays one colour. */
function distance(p: Lab, q: Lab): number {
  const dl = (p[0] - q[0]) * 0.5;
  return Math.hypot(dl, p[1] - q[1], p[2] - q[2]);
}

function labAt(image: RgbImage, i: number): Lab {
  return toLab(image.data[i * 3] ?? 0, image.data[i * 3 + 1] ?? 0, image.data[i * 3 + 2] ?? 0);
}

/** Deterministic k-means in Lab: starts from lightness quantiles. Returns centres and their shares, largest first. */
export function clusters(samples: readonly Lab[], k: number, minShare: number): { centre: Lab; share: number }[] {
  if (samples.length === 0) return [];
  const sorted = [...samples].sort((p, q) => p[0] - q[0]);
  let centres: Lab[] = Array.from({ length: Math.min(k, sorted.length) }, (_, i) => {
    const s = sorted[Math.floor(((i + 0.5) / k) * sorted.length)] ?? sorted[0];
    return s ? [s[0], s[1], s[2]] : [0, 0, 0];
  });
  let counts: number[] = [];
  for (let round = 0; round < 10; round += 1) {
    const sums = centres.map((): Lab => [0, 0, 0]);
    counts = centres.map(() => 0);
    for (const s of samples) {
      const c = nearest(s, centres);
      const sum = sums[c];
      if (!sum) continue;
      sum[0] += s[0];
      sum[1] += s[1];
      sum[2] += s[2];
      counts[c] = (counts[c] ?? 0) + 1;
    }
    centres = centres.map((old, c) => {
      const n = counts[c] ?? 0;
      const sum = sums[c];
      return n > 0 && sum ? [sum[0] / n, sum[1] / n, sum[2] / n] : old;
    });
  }
  // Merge near-identical centres, then keep the ones that matter.
  const merged: { centre: Lab; count: number }[] = [];
  centres
    .map((centre, c) => ({ centre, count: counts[c] ?? 0 }))
    .sort((p, q) => q.count - p.count)
    .forEach((entry) => {
      const twin = merged.find((m) => distance(m.centre, entry.centre) < 10);
      if (twin) twin.count += entry.count;
      else if (entry.count > 0) merged.push(entry);
    });
  return merged.map((m) => ({ centre: m.centre, share: m.count / samples.length })).filter((m) => m.share >= minShare);
}

export function nearest(p: Lab, centres: readonly Lab[]): number {
  let best = 0;
  let bestDistance = Infinity;
  centres.forEach((c, i) => {
    const d = distance(p, c);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  });
  return best;
}

/** The colours along the box's edges inside the garment (`inside`, 1 = garment): the fabric behind the decoration. */
export function edgeColours(image: RgbImage, inside: Uint8Array | null = null): Lab[] {
  const { width, height } = image;
  const ring = Math.max(2, Math.round(Math.min(width, height) * 0.04));
  const samples: Lab[] = [];
  const step = Math.max(1, Math.round((2 * (width + height) * ring) / 4000));
  let n = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x >= ring && x < width - ring && y >= ring && y < height - ring) continue;
      if (inside && !inside[y * width + x]) continue;
      if (n++ % step === 0) samples.push(labAt(image, y * width + x));
    }
  }
  // Up to three cloth colours (two-tone fabric, shade); colours on less of the edge are decorations the
  // box cuts through.
  return clusters(samples, 3, 0.3).map((c) => c.centre);
}

/** Alpha 0…255 per pixel: 0 where the pixel looks like the fabric, with a soft edge above the threshold. */
export function keyOut(image: RgbImage, fabric: readonly Lab[], strength: number, inside: Uint8Array | null = null): Uint8Array {
  const n = image.width * image.height;
  const alpha = new Uint8Array(n);
  const t = keyThreshold(strength);
  for (let i = 0; i < n; i += 1) {
    if (inside && !inside[i]) continue;
    const p = labAt(image, i);
    let d = Infinity;
    for (const f of fabric) d = Math.min(d, distance(p, f));
    const a = (d - t) / (t * 0.5);
    alpha[i] = Math.round(255 * Math.min(1, Math.max(0, a)));
  }
  return alpha;
}

/** Drops opaque specks smaller than `minArea` pixels (4-connected). */
export function dropSpecks(alpha: Uint8Array, width: number, height: number, minArea: number): void {
  const seen = new Uint8Array(alpha.length);
  const stack = new Int32Array(alpha.length);
  const component: number[] = [];
  for (let start = 0; start < alpha.length; start += 1) {
    if (seen[start] || (alpha[start] ?? 0) < 128) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    component.length = 0;
    while (top > 0) {
      const i = stack[--top] ?? 0;
      component.push(i);
      const x = i % width;
      const neighbours = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width];
      for (const j of neighbours) {
        if (j < 0 || j >= alpha.length || seen[j] || (alpha[j] ?? 0) < 128) continue;
        seen[j] = 1;
        stack[top++] = j;
      }
    }
    if (component.length < minArea) {
      for (const i of component) {
        alpha[i] = 0;
        // Its soft edge goes with it.
        const x = i % width;
        for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width]) {
          if (j >= 0 && j < alpha.length && (alpha[j] ?? 0) < 128) alpha[j] = 0;
        }
      }
    }
  }
}

/** Bounds of the pixels with alpha ≥ 128, padded by `pad`, or null when there are too few. */
export function opaqueBounds(alpha: Uint8Array, width: number, height: number, pad: number): { left: number; top: number; width: number; height: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((alpha[y * width + x] ?? 0) < 128) continue;
      count += 1;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (count < Math.max(16, width * height * 0.005)) return null;
  const left = Math.max(0, minX - pad);
  const top = Math.max(0, minY - pad);
  return { left, top, width: Math.min(width, maxX + pad + 1) - left, height: Math.min(height, maxY + pad + 1) - top };
}

/** The cut-out's main colours (up to 4), from its opaque pixels. */
export function mainColours(image: RgbImage, alpha: Uint8Array): Lab[] {
  const opaque: number[] = [];
  for (let i = 0; i < alpha.length; i += 1) if ((alpha[i] ?? 0) >= 128) opaque.push(i);
  const step = Math.max(1, Math.floor(opaque.length / 20000));
  const samples: Lab[] = [];
  for (let s = 0; s < opaque.length; s += step) samples.push(labAt(image, opaque[s] ?? 0));
  return clusters(samples, MAX_PALETTE, 0.04).map((c) => c.centre);
}

/**
 * Swaps the cut-out's main colours: `swaps[i]` replaces palette colour i (null keeps it). The pixel's
 * difference from its palette colour is kept, so stitches, shading and highlights survive.
 */
export function swapColours(image: RgbImage, alpha: Uint8Array, palette: readonly Lab[], swaps: readonly (string | null)[]): void {
  const targets = swaps.map((hex) => (hex ? hexToLab(hex) : null));
  if (targets.every((t) => t === null)) return;
  for (let i = 0; i < alpha.length; i += 1) {
    if ((alpha[i] ?? 0) === 0) continue;
    const p = labAt(image, i);
    const c = nearest(p, palette);
    const target = targets[c];
    const centre = palette[c];
    if (!target || !centre) continue;
    const [r, g, b] = labToRgb([target[0] + (p[0] - centre[0]), target[1] + (p[1] - centre[1]) * 0.3, target[2] + (p[2] - centre[2]) * 0.3]);
    image.data[i * 3] = r;
    image.data[i * 3 + 1] = g;
    image.data[i * 3 + 2] = b;
  }
}

export function hexToLab(hex: string): Lab {
  const v = Number.parseInt(hex.slice(1), 16);
  return toLab((v >> 16) & 255, (v >> 8) & 255, v & 255);
}

function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
}

export function labToRgb([l, a, b]: Lab): [number, number, number] {
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const x = inv(fx) * 0.95047;
  const y = inv(fy);
  const z = inv(fz) * 1.08883;
  return [
    linearToSrgb(3.2406 * x - 1.5372 * y - 0.4986 * z),
    linearToSrgb(-0.9689 * x + 1.8758 * y + 0.0415 * z),
    linearToSrgb(0.0557 * x - 0.204 * y + 1.057 * z),
  ];
}

export function labToHex(lab: Lab): string {
  return `#${labToRgb(lab)
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * The garment's outline in the whole photo (on a 400-px copy), holes filled and grown a little. The
 * garment finder leaves holes where decorations are; only the outline is used, to drop the mannequin
 * and backdrop.
 */
async function garmentOf(photo: Buffer): Promise<Mask | null> {
  try {
    return grow(fillHoles(findGarment(await readRgb(photo, 400))), 2);
  } catch (error) {
    if (error instanceof SegmentationError) return null;
    throw error;
  }
}

/** Fills everything the mask encloses: only background connected to the picture's border stays empty. */
export function fillHoles(mask: Mask): Mask {
  const { width, height } = mask;
  const outside = new Uint8Array(width * height);
  const stack: number[] = [];
  const visit = (i: number) => {
    if (!mask.data[i] && !outside[i]) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < width; x += 1) {
    visit(x);
    visit((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    visit(y * width);
    visit(y * width + width - 1);
  }
  while (stack.length > 0) {
    const i = stack.pop() ?? 0;
    const x = i % width;
    if (x > 0) visit(i - 1);
    if (x < width - 1) visit(i + 1);
    if (i >= width) visit(i - width);
    if (i + width < width * height) visit(i + width);
  }
  return { data: outside.map((v) => (v ? 0 : 1)), width, height };
}

/** Dilates a mask by `radius` pixels (square). */
export function grow(mask: Mask, radius: number): Mask {
  const { width, height } = mask;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask.data[y * width + x]) continue;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < width && ny < height) out[ny * width + nx] = 1;
        }
      }
    }
  }
  return { data: out, width, height };
}

/**
 * Which pixels of the box (worked on at `size`) are garment, or null when the mask can't be trusted
 * there (it covers under a fifth of the box: the garment finder probably missed a pale dress).
 */
export function garmentInBox(mask: Mask, photo: { width: number; height: number }, crop: { left: number; top: number; width: number; height: number }, size: { width: number; height: number }): Uint8Array | null {
  const inside = new Uint8Array(size.width * size.height);
  let count = 0;
  // Sampled bilinearly, so the coarse mask's edge comes out smooth rather than in steps.
  const at = (x: number, y: number) => mask.data[Math.min(mask.height - 1, Math.max(0, y)) * mask.width + Math.min(mask.width - 1, Math.max(0, x))] ?? 0;
  for (let y = 0; y < size.height; y += 1) {
    const my = ((crop.top + ((y + 0.5) / size.height) * crop.height) / photo.height) * mask.height - 0.5;
    const y0 = Math.floor(my);
    const fy = my - y0;
    for (let x = 0; x < size.width; x += 1) {
      const mx = ((crop.left + ((x + 0.5) / size.width) * crop.width) / photo.width) * mask.width - 0.5;
      const x0 = Math.floor(mx);
      const fx = mx - x0;
      const value = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
      if (value >= 0.5) {
        inside[y * size.width + x] = 1;
        count += 1;
      }
    }
  }
  return count >= inside.length * 0.2 ? inside : null;
}

export type CutoutImage = {
  /** WebP with transparency. */
  data: Buffer;
  width: number;
  height: number;
  /** The main colours before swaps, as hex (the same for the same photo, box and strength). */
  palette: string[];
};

/** Cuts the decoration inside `box` (fractions of the photo) out of a product photo. */
export async function cutOutDecoration(photo: Buffer, box: Box, strength: number, swaps: readonly (string | null)[] = []): Promise<CutoutImage> {
  const meta = await sharp(photo).metadata();
  const photoW = meta.width ?? 0;
  const photoH = meta.height ?? 0;
  const left = Math.max(0, Math.round(box.x * photoW));
  const top = Math.max(0, Math.round(box.y * photoH));
  const width = Math.min(photoW - left, Math.round(box.w * photoW));
  const height = Math.min(photoH - top, Math.round(box.h * photoH));
  if (width < MIN_BOX_PX || height < MIN_BOX_PX) {
    throw new CutoutError("TOO_SMALL", "Draw a bigger box around the decoration.");
  }
  const scale = Math.min(1, MAX_WORK_PX / Math.max(width, height));
  const crop = await sharp(photo).extract({ left, top, width, height }).png().toBuffer();
  const image = await readRgb(crop, scale < 1 ? Math.round(width * scale) : undefined);

  const mask = await garmentOf(photo);
  const inside = mask ? garmentInBox(mask, { width: photoW, height: photoH }, { left, top, width, height }, image) : null;
  const alpha = keyOut(image, edgeColours(image, inside), strength, inside);
  dropSpecks(alpha, image.width, image.height, Math.max(8, Math.round(image.width * image.height * 0.002)));
  const bounds = opaqueBounds(alpha, image.width, image.height, 2);
  if (!bounds) {
    throw new CutoutError("EMPTY", "Nothing stood out from the fabric there. Draw the box closer around the decoration, or remove less fabric.");
  }
  const palette = mainColours(image, alpha);
  swapColours(image, alpha, palette, swaps);

  const rgba = Buffer.alloc(image.width * image.height * 4);
  for (let p = 0; p < image.width * image.height; p += 1) {
    rgba[p * 4] = image.data[p * 3] ?? 0;
    rgba[p * 4 + 1] = image.data[p * 3 + 1] ?? 0;
    rgba[p * 4 + 2] = image.data[p * 3 + 2] ?? 0;
    rgba[p * 4 + 3] = alpha[p] ?? 0;
  }
  // Lossless: lossy WebP halves colour detail, which smears fine stitches into their surroundings.
  const data = await sharp(rgba, { raw: { width: image.width, height: image.height, channels: 4 } })
    .extract(bounds)
    .webp({ lossless: true, effort: 4 })
    .toBuffer();
  return { data, width: bounds.width, height: bounds.height, palette: palette.map(labToHex) };
}
