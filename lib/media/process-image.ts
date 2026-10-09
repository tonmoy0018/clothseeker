import sharp from "sharp";

// Untrusted image uploads → safe, normalized WebP.
//
// - The format is detected by decoding the bytes, never from the filename or the browser's MIME type.
// - Only raster JPEG/PNG/WebP are accepted (libvips can also read SVG, PDF, TIFF… — all rejected).
// - Re-encoding drops EXIF/GPS/ICC metadata (sharp strips it unless asked to keep it).
// - Output is resized to a sane maximum so stored files stay small and predictable.

/** Vercel Hobby rejects request bodies over 4.5 MB, so uploads are capped at 4 MB. */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_INPUT_EDGE = 8000;
const ALLOWED_FORMATS = new Set(["jpeg", "png", "webp"]);

export type ImagePurpose = "productPhoto" | "garment" | "styleReference" | "mask" | "designUpload" | "aiInput" | "aiMotif";

const RULES: Record<ImagePurpose, { minEdge: number; maxOutputEdge: number; output: "webp" | "mask-png" }> = {
  productPhoto: { minEdge: 600, maxOutputEdge: 2000, output: "webp" },
  garment: { minEdge: 800, maxOutputEdge: 2000, output: "webp" },
  styleReference: { minEdge: 300, maxOutputEdge: 1000, output: "webp" },
  // Region masks: single-channel, lossless so edges stay crisp. Resized to the garment at render time.
  mask: { minEdge: 400, maxOutputEdge: 2000, output: "mask-png" },
  // Customer images/logos for design layers. WebP keeps transparency (alpha) from PNG uploads.
  designUpload: { minEdge: 200, maxOutputEdge: 2000, output: "webp" },
  // Photos attached to an AI design request (inspiration, a logo of their own…).
  aiInput: { minEdge: 200, maxOutputEdge: 1600, output: "webp" },
  // Motifs returned by an image provider (untrusted bytes, same checks as uploads).
  aiMotif: { minEdge: 128, maxOutputEdge: 1024, output: "webp" },
};

export type ImageErrorCode = "EMPTY" | "TOO_LARGE" | "UNSUPPORTED" | "TOO_SMALL" | "DIMENSIONS_TOO_LARGE";

export class ImageValidationError extends Error {
  override readonly name = "ImageValidationError";

  constructor(
    readonly code: ImageErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type ProcessedImage = {
  data: Buffer;
  width: number;
  height: number;
  contentType: "image/webp" | "image/png";
  extension: "webp" | "png";
};

export async function processImage(input: Uint8Array, purpose: ImagePurpose): Promise<ProcessedImage> {
  const rules = RULES[purpose];
  if (input.byteLength === 0) {
    throw new ImageValidationError("EMPTY", "The file is empty.");
  }
  if (input.byteLength > MAX_UPLOAD_BYTES) {
    throw new ImageValidationError("TOO_LARGE", "Images must be 4 MB or smaller.");
  }

  const options = { limitInputPixels: MAX_INPUT_EDGE * MAX_INPUT_EDGE, failOn: "error" as const };
  let format: string | undefined;
  let width: number | undefined;
  let height: number | undefined;
  try {
    const meta = await sharp(input, options).metadata();
    format = meta.format;
    width = meta.width;
    height = meta.height;
  } catch {
    throw new ImageValidationError("UNSUPPORTED", "That file isn't a readable image. Upload a JPEG, PNG or WebP.");
  }

  if (!format || !ALLOWED_FORMATS.has(format)) {
    throw new ImageValidationError("UNSUPPORTED", "Only JPEG, PNG and WebP images are allowed.");
  }
  if (!width || !height) {
    throw new ImageValidationError("UNSUPPORTED", "That image has no readable size.");
  }
  if (width > MAX_INPUT_EDGE || height > MAX_INPUT_EDGE) {
    throw new ImageValidationError("DIMENSIONS_TOO_LARGE", `Images can be at most ${MAX_INPUT_EDGE} px on each side.`);
  }
  if (Math.min(width, height) < rules.minEdge) {
    throw new ImageValidationError(
      "TOO_SMALL",
      `This image is too small (${width}×${height}). It needs at least ${rules.minEdge} px on each side.`,
    );
  }

  try {
    const pipeline = sharp(input, options)
      .rotate() // apply EXIF orientation before the metadata is dropped
      .resize({ width: rules.maxOutputEdge, height: rules.maxOutputEdge, fit: "inside", withoutEnlargement: true });
    if (rules.output === "mask-png") {
      // Transparent pixels count as black (outside the region).
      const { data, info } = await pipeline
        .flatten({ background: "#000000" })
        .greyscale()
        .extractChannel(0)
        .toColourspace("b-w")
        .png({ compressionLevel: 9 })
        .toBuffer({ resolveWithObject: true });
      return { data, width: info.width, height: info.height, contentType: "image/png", extension: "png" };
    }
    const { data, info } = await pipeline.webp({ quality: 88, alphaQuality: 100 }).toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, contentType: "image/webp", extension: "webp" };
  } catch {
    throw new ImageValidationError("UNSUPPORTED", "That image couldn't be processed. Try exporting it again as JPEG or PNG.");
  }
}
