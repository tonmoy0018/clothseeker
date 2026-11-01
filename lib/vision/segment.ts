import type { FitBox } from "./geometry";

// MediaPipe selfie segmentation (onnx-community/mediapipe_selfie_segmentation, int8, Apache-2.0): how
// likely each pixel is part of a person. Input: float32 [1, 3, 256, 256] RGB scaled to 0–1. Output:
// `alphas` [1, 1, 256, 256], 0–1, in the letterboxed square.

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

/** A person mask: `alpha` is SELFIE_SIZE² values in letterbox space; `box` maps it to the source. */
export type PersonMask = { alpha: Float32Array; box: FitBox };

/** How likely the source pixel (x, y) is part of the person (0 outside the letterboxed area). */
export function maskAt(mask: PersonMask, x: number, y: number): number {
  const mx = Math.floor(x * mask.box.scale + mask.box.offsetX);
  const my = Math.floor(y * mask.box.scale + mask.box.offsetY);
  if (mx < 0 || my < 0 || mx >= SELFIE_SIZE || my >= SELFIE_SIZE) return 0;
  return mask.alpha[my * SELFIE_SIZE + mx] ?? 0;
}

/** Like maskAt, but interpolated between the mask's pixels, so outlines drawn from it aren't blocky. */
export function maskAtSmooth(mask: PersonMask, x: number, y: number): number {
  const mx = x * mask.box.scale + mask.box.offsetX - 0.5;
  const my = y * mask.box.scale + mask.box.offsetY - 0.5;
  const fx = Math.floor(mx);
  const fy = Math.floor(my);
  const tx = mx - fx;
  const ty = my - fy;
  const at = (px: number, py: number) => (px < 0 || py < 0 || px >= SELFIE_SIZE || py >= SELFIE_SIZE ? 0 : (mask.alpha[py * SELFIE_SIZE + px] ?? 0));
  const top = at(fx, fy) * (1 - tx) + at(fx + 1, fy) * tx;
  const bottom = at(fx, fy + 1) * (1 - tx) + at(fx + 1, fy + 1) * tx;
  return top * (1 - ty) + bottom * ty;
}
