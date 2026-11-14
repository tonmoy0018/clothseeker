// MediaPipe selfie multiclass (senty-au/selfie_multiclass_256x256-ONNX, Google's weights, Apache-2.0):
// what each pixel of a person is. Input `input_29`: float32 [1, 256, 256, 3] RGB scaled to 0–1, the
// picture stretched (not letterboxed) to the square. Output `Identity`: [1, 256, 256, 6] scores per
// class. It was made for people who fill the picture, so give it a crop around the person.

export const PARTS_SIZE = 256;
export const PARTS_INPUT = "input_29";
export const PARTS_OUTPUT = "Identity";

export const PART = { background: 0, hair: 1, bodySkin: 2, faceSkin: 3, clothes: 4, others: 5 } as const;
export type Part = (typeof PART)[keyof typeof PART];
const CLASSES = 6;

/** Pixels of the 256×256 stretched picture (RGB or RGBA) → the model's input (0–1, pixel by pixel). */
export function partsInput(pixels: ArrayLike<number>, channels: 3 | 4): Float32Array {
  const plane = PARTS_SIZE * PARTS_SIZE;
  const out = new Float32Array(plane * 3);
  for (let p = 0; p < plane; p += 1) {
    for (let c = 0; c < 3; c += 1) out[p * 3 + c] = (pixels[p * channels + c] ?? 0) / 255;
  }
  return out;
}

/** The model's scores → the likeliest class of each of the 256×256 pixels. */
export function decodeParts(scores: ArrayLike<number>): Uint8Array {
  const plane = PARTS_SIZE * PARTS_SIZE;
  const out = new Uint8Array(plane);
  for (let p = 0; p < plane; p += 1) {
    let best = 0;
    for (let c = 1; c < CLASSES; c += 1) if ((scores[p * CLASSES + c] ?? -Infinity) > (scores[p * CLASSES + best] ?? -Infinity)) best = c;
    out[p] = best;
  }
  return out;
}

/** The classes of a region of the source picture: `classes` is PARTS_SIZE² values, stretched over `region`. */
export type BodyParts = { classes: Uint8Array; region: { left: number; top: number; width: number; height: number } };

/** What the source pixel (x, y) is; background outside the region. */
export function partAt(parts: BodyParts, x: number, y: number): Part {
  const { left, top, width, height } = parts.region;
  const px = Math.floor(((x - left) / width) * PARTS_SIZE);
  const py = Math.floor(((y - top) / height) * PARTS_SIZE);
  if (px < 0 || py < 0 || px >= PARTS_SIZE || py >= PARTS_SIZE) return PART.background;
  const value = parts.classes[py * PARTS_SIZE + px];
  return value === PART.hair || value === PART.bodySkin || value === PART.faceSkin || value === PART.clothes || value === PART.others ? value : PART.background;
}
