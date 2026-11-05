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
/** Shoulder width as a fraction of the picture width (shirts and panjabis are lined up by it). */
export const SHOULDERS = 0.36;
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
/** A box as fractions (0–1) of the photo. */
export type PhotoBox = { top: number; left: number; bottom: number; right: number };

/**
 * Segments a photo (on a smaller copy, for speed) and returns its parts in that copy's pixels. `within`
 * keeps only the garment inside that box (a little margin around it): the backdrop is still learned from
 * the whole photo's edges, but trousers below a jacket or a bag beside a dress aren't taken along.
 */
export async function analysePhoto(
  input: Buffer,
  workWidth = 400,
  colours: "one" | "several" = "one",
  within?: PhotoBox,
): Promise<{ parts: GarmentParts; scale: number }> {
  const image = await readRgb(input, workWidth);
  const meta = await sharp(input).metadata();
  let garment = findGarment(image, { colours });
  if (within) {
    const margin = 0.02;
    const x0 = (within.left - margin) * image.width;
    const x1 = (within.right + margin) * image.width;
    const y0 = (within.top - margin) * image.height;
    const y1 = (within.bottom + margin) * image.height;
    const kept = Uint8Array.from(garment.data, (v, i) => {
      const x = i % image.width;
      const y = Math.floor(i / image.width);
      return v && x >= x0 && x <= x1 && y >= y0 && y <= y1 ? 1 : 0;
    });
    if (kept.some((v) => v === 1)) garment = { ...garment, data: kept };
  }
  return { parts: splitGarment(garment), scale: (meta.width ?? workWidth) / workWidth };
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
 * How a garment's pictures are sized: dresses by their shoulders-to-waist height, shirts and panjabis
 * (no clear waist) by their shoulder width.
 */
export type AlignBy = "torso" | "shoulders";

/**
 * Scales and moves the photo so the garment's shoulders sit at SHOULDER_Y, centred, with a shoulders-to-waist
 * height of TORSO (or a shoulder width of SHOULDERS); the photo's edges are stretched to fill the rest.
 * The garment is found and split once, on the original photo, and its part masks are moved with it.
 */
export async function alignGarmentPhoto(input: Buffer, alignBy: AlignBy = "torso"): Promise<AlignedPhoto> {
  // Finer than the default, so the mask edges are smooth at full size.
  const { parts, scale } = await analysePhoto(input, 800);
  const meta = await sharp(input).metadata();
  const sourceW = meta.width ?? 1;
  const sourceH = meta.height ?? 1;

  const torso = Math.max(1, (parts.waistY - parts.shoulderY) * scale);
  const dress = Math.max(1, (parts.hemY - parts.shoulderY) * scale);
  const wanted = alignBy === "torso" ? (TORSO * PHOTO_HEIGHT) / torso : (SHOULDERS * PHOTO_WIDTH) / (parts.shoulderWidth * scale);
  const factor = Math.min(wanted, ((HEM_LIMIT - SHOULDER_Y) * PHOTO_HEIGHT) / dress);
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
export async function alignPhoto(input: Buffer, alignBy: AlignBy = "torso"): Promise<Buffer> {
  return (await alignGarmentPhoto(input, alignBy)).image;
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

/**
 * Just the dress from a catalogue photo, on a transparent background (no mannequin, stand or
 * studio backdrop), as try-on models expect a garment. Throws SegmentationError if no dress is found.
 */
export async function cutOutGarment(input: Buffer): Promise<Buffer> {
  const { parts } = await analysePhoto(input, 800);
  const meta = await sharp(input).metadata();
  const width = meta.width ?? 1;
  const height = meta.height ?? 1;
  const rgb = await sharp(input).removeAlpha().raw().toBuffer();
  const alpha = await sharp(await maskPng(parts.garment, width, height)).blur(1).extractChannel(0).raw().toBuffer();
  const rgba = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p += 1) {
    rgba[p * 4] = rgb[p * 3] ?? 0;
    rgba[p * 4 + 1] = rgb[p * 3 + 1] ?? 0;
    rgba[p * 4 + 2] = rgb[p * 3 + 2] ?? 0;
    rgba[p * 4 + 3] = alpha[p] ?? 0;
  }
  return sharp(rgba, { raw: { width, height, channels: 4 } }).trim().png().toBuffer();
}

/** The plain studio backdrop a customer's own garment is shown on, like the catalogue's photos. */
export const BACKDROP = { r: 241, g: 240, b: 237 };
/** Real width across a garment's shoulders (cm), to size print areas on a framed photo. */
const SHOULDER_CM: Record<AlignBy, number> = { torso: 37, shoulders: 46 };

export type FramedPhoto = AlignedPhoto & {
  /** Real size of the whole picture in cm, from the garment's shoulder width. */
  pictureCm: { w: number; h: number };
};

/**
 * A customer's own garment photo, shown whole: the garment is cut out (backdrop, mannequin and stand
 * removed), scaled to fit the picture without cropping, and centred on a plain studio backdrop, with its
 * part masks moved along. Unlike alignGarmentPhoto there's no catalogue framing to match, so nothing of
 * the garment is cut off or blown up. Throws SegmentationError if no garment is found.
 */
export async function frameGarmentPhoto(input: Buffer, alignBy: AlignBy = "torso", within?: PhotoBox): Promise<FramedPhoto> {
  // A customer's garment may be more than one colour (a jacket open over a shirt).
  const { parts, scale } = await analysePhoto(input, 800, "several", within);
  const meta = await sharp(input).metadata();
  const sourceW = meta.width ?? 1;
  const sourceH = meta.height ?? 1;

  // The garment's box in the source photo.
  let x0 = parts.garment.width;
  let y0 = parts.garment.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < parts.garment.height; y += 1) {
    for (let x = 0; x < parts.garment.width; x += 1) {
      if (!parts.garment.data[y * parts.garment.width + x]) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  const box = {
    left: Math.max(0, Math.floor(x0 * scale)),
    top: Math.max(0, Math.floor(y0 * scale)),
    width: 0,
    height: 0,
  };
  box.width = Math.max(1, Math.min(sourceW - box.left, Math.ceil((x1 + 1) * scale) - box.left));
  box.height = Math.max(1, Math.min(sourceH - box.top, Math.ceil((y1 + 1) * scale) - box.top));

  // Fit inside the picture with a little room around it (more below, like a catalogue shot).
  const factor = Math.min((PHOTO_WIDTH * 0.88) / box.width, (PHOTO_HEIGHT * 0.92) / box.height);
  const outW = Math.max(1, Math.round(box.width * factor));
  const outH = Math.max(1, Math.round(box.height * factor));
  const left = Math.round((PHOTO_WIDTH - outW) / 2);
  const top = Math.round(PHOTO_HEIGHT * 0.04);

  /** A source-sized single-channel image, cropped to the garment and placed on the picture. */
  const placeGrey = async (grey: Buffer, blur: number) =>
    sharp(
      await sharp(grey)
        .extract(box)
        .resize(outW, outH, { fit: "fill", kernel: "lanczos3" })
        .extend({ left, top, right: PHOTO_WIDTH - left - outW, bottom: PHOTO_HEIGHT - top - outH, background: "#000000" })
        .toBuffer(),
    )
      .extractChannel(0)
      .blur(blur)
      .toColourspace("b-w")
      .png({ compressionLevel: 9 })
      .toBuffer();

  // The garment on the backdrop, with soft edges.
  // (.raw() would expand the grey PNG to three channels: take the one.)
  const alpha = await sharp(await placeGrey(await maskPng(parts.garment, sourceW, sourceH), 0.8)).extractChannel(0).raw().toBuffer();
  const garment = await sharp(input).removeAlpha().extract(box).resize(outW, outH, { fit: "fill", kernel: "lanczos3" }).raw().toBuffer();
  const rgb = Buffer.alloc(PHOTO_WIDTH * PHOTO_HEIGHT * 3);
  for (let y = 0; y < PHOTO_HEIGHT; y += 1) {
    for (let x = 0; x < PHOTO_WIDTH; x += 1) {
      const p = y * PHOTO_WIDTH + x;
      const a = (alpha[p] ?? 0) / 255;
      const gx = x - left;
      const gy = y - top;
      const inside = gx >= 0 && gy >= 0 && gx < outW && gy < outH;
      const g = (gy * outW + gx) * 3;
      rgb[p * 3] = Math.round((inside ? (garment[g] ?? 0) : 0) * a + BACKDROP.r * (1 - a));
      rgb[p * 3 + 1] = Math.round((inside ? (garment[g + 1] ?? 0) : 0) * a + BACKDROP.g * (1 - a));
      rgb[p * 3 + 2] = Math.round((inside ? (garment[g + 2] ?? 0) : 0) * a + BACKDROP.b * (1 - a));
    }
  }
  const image = await sharp(rgb, { raw: { width: PHOTO_WIDTH, height: PHOTO_HEIGHT, channels: 3 } })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();

  const workW = 400;
  const workH = Math.round((workW * PHOTO_HEIGHT) / PHOTO_WIDTH);
  const moveMask = async (mask: Mask) => {
    const grey = await placeGrey(await maskPng(mask, sourceW, sourceH), 1.2);
    const small = await sharp(grey).resize(workW, workH, { fit: "fill" }).extractChannel(0).raw().toBuffer();
    const work: Mask = { data: Uint8Array.from(small, (v) => (v >= 128 ? 1 : 0)), width: workW, height: workH };
    return { png: grey, work };
  };

  // Shoulders are found reliably on single garments; an outfit or an open jacket can fool it, so it's
  // kept within what a garment's shoulders can be against its own width.
  const shoulderPx = Math.min(outW, Math.max(outW * 0.45, parts.shoulderWidth * scale * factor));
  const cmPerPx = SHOULDER_CM[alignBy] / shoulderPx;
  return {
    image,
    masks: { sleeves: await moveMask(parts.sleeves), bodice: await moveMask(parts.bodice), skirt: await moveMask(parts.skirt) },
    pictureCm: { w: PHOTO_WIDTH * cmPerPx, h: PHOTO_HEIGHT * cmPerPx },
  };
}
