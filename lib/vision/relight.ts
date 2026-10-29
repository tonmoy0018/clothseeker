// Relighting for the live mirror: how the camera's light should change the garment, as a small RGBA
// "shade" picture used with the canvas's soft-light blend (mid-grey = no change, darker = shade,
// lighter = light). It carries:
//  - creases and folds: the brightness of what the person wears, relative to its surroundings, so the
//    garment folds where their clothes fold;
//  - the room's light: brighter and darker sides of the body;
//  - the colour cast: warm or cool light tints the garment like everything else in the picture.
// Pure, so it is unit-tested; the browser runs it on a small copy of each frame.

/** How strongly the camera's light shows on the garment (0 = not at all). */
export const RELIGHT_STRENGTH = 0.55;

function boxBlur(src: Float32Array, width: number, height: number, radius: number): Float32Array {
  if (radius < 1) return src;
  const pass = (input: Float32Array, horizontal: boolean): Float32Array => {
    const out = new Float32Array(input.length);
    const lines = horizontal ? height : width;
    const span = horizontal ? width : height;
    for (let line = 0; line < lines; line += 1) {
      const at = (i: number) => (horizontal ? line * width + i : i * width + line);
      let sum = 0;
      for (let i = -radius; i <= radius; i += 1) sum += input[at(Math.min(span - 1, Math.max(0, i)))] ?? 0;
      for (let i = 0; i < span; i += 1) {
        out[at(i)] = sum / (2 * radius + 1);
        sum += (input[at(Math.min(span - 1, i + radius + 1))] ?? 0) - (input[at(Math.max(0, i - radius))] ?? 0);
      }
    }
    return out;
  };
  return pass(pass(src, true), false);
}

/**
 * The shade picture (RGBA, same size) for a small RGBA copy of a camera frame. Mid-grey (128) wherever
 * the light is even and neutral.
 */
export function shadeFromFrame(rgba: ArrayLike<number>, width: number, height: number, strength = RELIGHT_STRENGTH): Uint8ClampedArray<ArrayBuffer> {
  const n = width * height;
  const luma = new Float32Array(n);
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (let p = 0; p < n; p += 1) {
    const r = rgba[p * 4] ?? 0;
    const g = rgba[p * 4 + 1] ?? 0;
    const b = rgba[p * 4 + 2] ?? 0;
    luma[p] = 0.2126 * r + 0.7152 * g + 0.0722 * b + 1;
    sumR += r;
    sumG += g;
    sumB += b;
  }
  const fine = boxBlur(luma, width, height, 1);
  const broad = boxBlur(boxBlur(luma, width, height, Math.max(2, Math.round(width / 18))), width, height, Math.max(2, Math.round(width / 18)));
  const sorted = Array.from(broad).sort((a, b) => a - b);
  const median = Math.max(1, sorted[Math.floor(sorted.length / 2)] ?? 128);
  // Grey-world colour cast, kept mild: a garment shouldn't change colour, only look lit by the same light.
  const mean = (sumR + sumG + sumB) / 3 || 1;
  const cast = [sumR / mean, sumG / mean, sumB / mean].map((c) => Math.min(1.1, Math.max(0.9, c)));
  const out = new Uint8ClampedArray(n * 4);
  for (let p = 0; p < n; p += 1) {
    const folds = Math.min(1.4, Math.max(0.6, (fine[p] ?? 1) / (broad[p] ?? 1)));
    const light = Math.min(1.25, Math.max(0.75, (broad[p] ?? median) / median));
    const level = folds * Math.sqrt(light);
    for (let c = 0; c < 3; c += 1) {
      const v = 0.5 + (level * (cast[c] ?? 1) - 1) * strength;
      out[p * 4 + c] = Math.round(Math.min(0.85, Math.max(0.15, v)) * 255);
    }
    out[p * 4 + 3] = 255;
  }
  return out;
}

/** Softens a mask's edge (alpha 0–255, in place) with a small blur, so cut-out edges don't look cut. */
export function featherAlpha(alpha: Uint8ClampedArray | Uint8Array, width: number, height: number, radius = 1): void {
  const values = new Float32Array(width * height);
  for (let p = 0; p < values.length; p += 1) values[p] = alpha[p] ?? 0;
  const soft = boxBlur(boxBlur(values, width, height, radius), width, height, radius);
  for (let p = 0; p < values.length; p += 1) alpha[p] = Math.round(Math.min(alpha[p] ?? 0, soft[p] ?? 0) * 0.5 + (soft[p] ?? 0) * 0.5);
}
