import type { FitBox } from "./geometry";

// The person outline: how likely each pixel is part of a person. Two models:
// - MediaPipe selfie segmentation (onnx-community/mediapipe_selfie_segmentation, int8, Apache-2.0), small
//   and fast everywhere. Input: float32 [1, 3, 256, 256] RGB scaled to 0–1. Output: `alphas`
//   [1, 1, 256, 256], 0–1, in the letterboxed square. Coarse: blobby edges, and blobs beside the legs.
// - MODNet (Xenova/modnet, fp16, Apache-2.0), portrait matting: a clean, sharp outline at about the same
//   cost on a GPU (and 8× slower without one). Input: `input` float32 [1, 3, H, W] RGB scaled to −1…1, the
//   frame letterboxed into its own shape (MATTE_LONG on the long side, both sides multiples of 32).
//   Output: `output` [1, 1, H, W], 0–1.

export const SELFIE_SIZE = 256;

/** RGBA pixels of the 256×256 letterboxed frame → the model's planar RGB input (0–1). */
export function selfieInput(rgba: ArrayLike<number>): Float32Array {
  const plane = SELFIE_SIZE * SELFIE_SIZE;
  const out = new Float32Array(plane * 3);
  for (let p = 0; p < plane; p += 1) {
    out[p] = (rgba[p * 4] ?? 0) / 255;
    out[plane + p] = (rgba[p * 4 + 1] ?? 0) / 255;
    out[plane * 2 + p] = (rgba[p * 4 + 2] ?? 0) / 255;
  }
  return out;
}

/** The matting model's longer side in pixels: 384 × 224 for a 16:9 camera (about 60 ms on an M1's GPU). */
export const MATTE_LONG = 384;

/** The matting model's input size for a frame: its shape, MATTE_LONG on the long side, multiples of 32. */
export function matteSize(frameWidth: number, frameHeight: number): { width: number; height: number } {
  const side = (n: number) => Math.max(32, Math.ceil(n / 32) * 32);
  return frameWidth >= frameHeight
    ? { width: MATTE_LONG, height: side((MATTE_LONG * frameHeight) / Math.max(frameWidth, 1)) }
    : { width: side((MATTE_LONG * frameWidth) / Math.max(frameHeight, 1)), height: MATTE_LONG };
}

/** RGBA pixels of the letterboxed frame → the matting model's planar RGB input (−1…1). */
export function matteInput(rgba: ArrayLike<number>, width: number, height: number): Float32Array {
  const plane = width * height;
  const out = new Float32Array(plane * 3);
  for (let p = 0; p < plane; p += 1) {
    out[p] = (rgba[p * 4] ?? 0) / 127.5 - 1;
    out[plane + p] = (rgba[p * 4 + 1] ?? 0) / 127.5 - 1;
    out[plane * 2 + p] = (rgba[p * 4 + 2] ?? 0) / 127.5 - 1;
  }
  return out;
}

/**
 * A person mask: `alpha` is width × height values in the model's (letterboxed) space; `box` maps it to the
 * source. The selfie model's is SELFIE_SIZE square; the matting model's has the frame's shape.
 */
export type PersonMask = { alpha: Float32Array; width: number; height: number; box: FitBox };

/** How likely the source pixel (x, y) is part of the person (0 outside the letterboxed area). */
export function maskAt(mask: PersonMask, x: number, y: number): number {
  const mx = Math.floor(x * mask.box.scale + mask.box.offsetX);
  const my = Math.floor(y * mask.box.scale + mask.box.offsetY);
  if (mx < 0 || my < 0 || mx >= mask.width || my >= mask.height) return 0;
  return mask.alpha[my * mask.width + mx] ?? 0;
}

/** Like maskAt, but interpolated between the mask's pixels, so outlines drawn from it aren't blocky. */
export function maskAtSmooth(mask: PersonMask, x: number, y: number): number {
  const mx = x * mask.box.scale + mask.box.offsetX - 0.5;
  const my = y * mask.box.scale + mask.box.offsetY - 0.5;
  const fx = Math.floor(mx);
  const fy = Math.floor(my);
  const tx = mx - fx;
  const ty = my - fy;
  const at = (px: number, py: number) => (px < 0 || py < 0 || px >= mask.width || py >= mask.height ? 0 : (mask.alpha[py * mask.width + px] ?? 0));
  const top = at(fx, fy) * (1 - tx) + at(fx + 1, fy) * tx;
  const bottom = at(fx, fy + 1) * (1 - tx) + at(fx + 1, fy + 1) * tx;
  return top * (1 - ty) + bottom * ty;
}
