import sharp from "sharp";

import { AiProviderError } from "./errors";

// Image helpers shared by the AI pipelines (worker side).

/**
 * Provider images often come on a white background; make near-white transparent so only the motif
 * is printed, then crop the empty margins. Also decodes the untrusted bytes, so anything that isn't
 * an image fails here.
 */
export async function knockOutWhite(input: Buffer): Promise<Buffer> {
  let raw;
  try {
    raw = await sharp(input, { limitInputPixels: 4096 * 4096, failOn: "error" })
      .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new AiProviderError("image provider returned an unreadable image", true);
  }
  const { data, info } = raw;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const lightest = Math.min(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
    if (lightest >= 245) {
      data[i + 3] = 0;
    } else if (lightest > 225) {
      // Soft edge between the motif and the background.
      data[i + 3] = Math.min(data[i + 3] ?? 255, Math.round(((245 - lightest) / 20) * 255));
    }
  }
  const cleaned = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  // Image models leave wide empty margins; crop to the motif so it fills its box on the dress.
  let trimmed: Buffer;
  try {
    trimmed = await sharp(cleaned).trim({ threshold: 1 }).png().toBuffer();
  } catch {
    return cleaned; // nothing left to trim against (e.g. a fully transparent image)
  }
  // A thin motif (a stem, a sprig) can end up very narrow: pad it back to a usable size.
  const meta = await sharp(trimmed).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const padX = Math.max(0, Math.ceil((MIN_MOTIF_EDGE - width) / 2));
  const padY = Math.max(0, Math.ceil((MIN_MOTIF_EDGE - height) / 2));
  if (padX === 0 && padY === 0) {
    return trimmed;
  }
  return sharp(trimmed)
    .extend({ left: padX, right: padX, top: padY, bottom: padY, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

/** Smallest edge a motif keeps after cropping (processImage("aiMotif") needs at least 128 px). */
export const MIN_MOTIF_EDGE = 160;

/** Width × height of the garment canvas try-on models expect (3:4, like their training data). */
export const GARMENT_CANVAS = { width: 768, height: 1024 } as const;

/**
 * A garment as try-on models expect it: cropped tight, centred on a plain white 3:4 canvas with a
 * small margin. Transparent areas become white.
 */
export async function prepareGarment(input: Buffer): Promise<Buffer> {
  const flat = await sharp(input).flatten({ background: "#ffffff" }).png().toBuffer();
  let trimmed: Buffer;
  try {
    trimmed = await sharp(flat).trim({ threshold: 10 }).toBuffer();
  } catch {
    trimmed = flat;
  }
  const inner = await sharp(trimmed)
    .resize(GARMENT_CANVAS.width - 68, GARMENT_CANVAS.height - 64, { fit: "inside" })
    .toBuffer();
  return sharp({ create: { ...GARMENT_CANVAS, channels: 3, background: "#ffffff" } })
    .composite([{ input: inner, gravity: "center" }])
    .png()
    .toBuffer();
}
