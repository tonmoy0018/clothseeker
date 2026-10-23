import sharp from "sharp";

import { findGarment, splitGarment, type GarmentParts, type Mask, type RgbImage } from "./segment";

// Lines garment photos up so every style picture of a dress has the same framing: shoulders at the
// same height, centred, and the same shoulders-to-waist size, so the body is the same size in every
// picture and only the hem moves with the length. Print areas (fractions of the picture) then land on
// the same part of the dress in every picture.

export const PHOTO_WIDTH = 900;
export const PHOTO_HEIGHT = 1170; // 1200×1560 proportions, like the drawn garments
export const SHOULDER_Y = 0.06;
/** Shoulders-to-waist height as a fraction of the picture. */
export const TORSO = 0.19;
/** Lowest the hem may reach; a very long dress is scaled down to fit. */
const HEM_LIMIT = 0.97;

export async function readRgb(input: Buffer, width?: number): Promise<RgbImage> {
  const { data, info } = await sharp(input)
    .resize(width ? { width } : undefined)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

/** Segments a photo (on a smaller copy, for speed) and returns its parts in that copy's pixels. */
export async function analysePhoto(input: Buffer, workWidth = 400): Promise<{ parts: GarmentParts; scale: number }> {
  const image = await readRgb(input, workWidth);
  const meta = await sharp(input).metadata();
  return { parts: splitGarment(findGarment(image)), scale: (meta.width ?? workWidth) / workWidth };
}

type Placement = { scaledW: number; scaledH: number; left: number; top: number };

/** Puts an image of the source photo's size onto the lined-up canvas, extending its edges as needed. */
async function place(input: Buffer, at: Placement, extendWith: "copy" | "background"): Promise<Buffer> {
  const padLeft = Math.max(0, at.left);
  const padTop = Math.max(0, at.top);
  const padRight = Math.max(0, PHOTO_WIDTH - at.left - at.scaledW);
  const padBottom = Math.max(0, PHOTO_HEIGHT - at.top - at.scaledH);
  // Two steps: sharp applies extract before extend within one pipeline.
  const extended = await sharp(input)
    .resize(at.scaledW, at.scaledH, { fit: "fill" })
    .extend({ left: padLeft, top: padTop, right: padRight, bottom: padBottom, extendWith, background: "#000000" })
    .toBuffer();
  return sharp(extended)
    .extract({ left: padLeft - at.left, top: padTop - at.top, width: PHOTO_WIDTH, height: PHOTO_HEIGHT })
    .toBuffer();
}

export type AlignedPhoto = {
  /** The lined-up picture (JPEG, PHOTO_WIDTH × PHOTO_HEIGHT). */
  image: Buffer;
  /** Part masks moved with the picture: grey PNGs at full size, and small Masks for measuring. */
  masks: Record<"sleeves" | "bodice" | "skirt", { png: Buffer; work: Mask }>;
};

/**
 * Scales and moves the photo so the dress's shoulders sit at SHOULDER_Y, centred, with a shoulders-to-waist
 * height of TORSO; the photo's edges are stretched to fill the rest. The dress is found and split once,
 * on the original photo, and its part masks are moved with it.
 */
export async function alignGarmentPhoto(input: Buffer): Promise<AlignedPhoto> {
  // Finer than the default, so the mask edges are smooth at full size.
  const { parts, scale } = await analysePhoto(input, 800);
  const meta = await sharp(input).metadata();
  const sourceW = meta.width ?? 1;
  const sourceH = meta.height ?? 1;

  const torso = Math.max(1, (parts.waistY - parts.shoulderY) * scale);
  const dress = Math.max(1, (parts.hemY - parts.shoulderY) * scale);
  const factor = Math.min((TORSO * PHOTO_HEIGHT) / torso, ((HEM_LIMIT - SHOULDER_Y) * PHOTO_HEIGHT) / dress);
  const at: Placement = {
    scaledW: Math.max(1, Math.round(sourceW * factor)),
    scaledH: Math.max(1, Math.round(sourceH * factor)),
    left: Math.round(PHOTO_WIDTH / 2 - parts.centreX * scale * factor),
    top: Math.round(SHOULDER_Y * PHOTO_HEIGHT - parts.shoulderY * scale * factor),
  };

  const image = await sharp(await place(input, at, "copy"))
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
  const workW = 400;
  const workH = Math.round((workW * PHOTO_HEIGHT) / PHOTO_WIDTH);
  const moveMask = async (mask: Mask) => {
    const grey = await sharp(await place(await maskPng(mask, sourceW, sourceH), at, "background"))
      .extractChannel(0)
      .blur(1.2) // soft, anti-aliased edges
      .toColourspace("b-w")
      .png({ compressionLevel: 9 })
      .toBuffer();
    const small = await sharp(grey).resize(workW, workH, { fit: "fill" }).extractChannel(0).raw().toBuffer();
    const work: Mask = { data: Uint8Array.from(small, (v) => (v >= 128 ? 1 : 0)), width: workW, height: workH };
    return { png: grey, work };
  };
  return {
    image,
    masks: { sleeves: await moveMask(parts.sleeves), bodice: await moveMask(parts.bodice), skirt: await moveMask(parts.skirt) },
  };
}

/** The lined-up picture only. */
export async function alignPhoto(input: Buffer): Promise<Buffer> {
  return (await alignGarmentPhoto(input)).image;
}

/** A mask as a greyscale PNG at the given size (white = inside). */
export async function maskPng(mask: Mask, width: number, height: number): Promise<Buffer> {
  const grey = Buffer.alloc(mask.width * mask.height);
  for (let i = 0; i < grey.length; i += 1) grey[i] = mask.data[i] ? 255 : 0;
  return sharp(grey, { raw: { width: mask.width, height: mask.height, channels: 1 } })
    .resize(width, height, { kernel: "lanczos3" })
    .toColourspace("b-w")
    .png({ compressionLevel: 9 })
    .toBuffer();
}
