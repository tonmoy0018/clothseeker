// Makes printed items (text, decorations, images) look printed on the fabric instead of floating flat:
//  - they curve away at the sides of the body, as if wrapped around it (a partial cylinder per row of
//    the garment's outline);
//  - they bend along folds (shifted by the slope of the fabric's smoothed brightness, like a
//    displacement map made from the photo's own creases);
//  - they take the fabric's light and shadow (scaled by the fabric's brightness relative to its median).
// Pure and shared by the server renderer and the browser preview, so both draw the same thing.
// Production print files stay flat: the printer prints flat and the real fabric does the bending.

export type FabricField = {
  width: number;
  height: number;
  /** Where each output pixel samples the flat layers from (absolute source coordinates). */
  sourceX: Float32Array;
  sourceY: Float32Array;
  /** Brightness factor for each output pixel (1 = unchanged). */
  shade: Float32Array;
};

/** How strongly prints wrap around the body: 0 = flat, 1 = a full half-cylinder. */
const WRAP = 0.4;
/** Fold displacement: pixels of shift per unit of brightness slope, as a share of the width. */
const FOLD_STRENGTH = 0.6;
/** Folds never move a print by more than this share of the width. */
const MAX_FOLD_SHIFT = 0.016;
const SHADE_MIN = 0.42;
const SHADE_MAX = 1.25;

function brightness(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Separable box blur (two passes ≈ a soft Gaussian) of a width×height float image. */
function blur(src: Float32Array, width: number, height: number, radius: number): Float32Array {
  if (radius < 1) return src;
  const pass = (input: Float32Array, horizontal: boolean): Float32Array => {
    const out = new Float32Array(input.length);
    const lines = horizontal ? height : width;
    const length = horizontal ? width : height;
    for (let line = 0; line < lines; line += 1) {
      const at = (i: number) => (horizontal ? line * width + i : i * width + line);
      let sum = 0;
      for (let i = -radius; i <= radius; i += 1) sum += input[at(Math.min(length - 1, Math.max(0, i)))] ?? 0;
      for (let i = 0; i < length; i += 1) {
        out[at(i)] = sum / (2 * radius + 1);
        sum += (input[at(Math.min(length - 1, i + radius + 1))] ?? 0) - (input[at(Math.max(0, i - radius))] ?? 0);
      }
    }
    return out;
  };
  return pass(pass(src, true), false);
}

/**
 * The field for one garment picture. `rgb` has `channels` values per pixel (3 or 4); `fabric` is the
 * garment's outline, one value per pixel at `fabricStride` (≥ 128 = fabric). Off the fabric the field
 * leaves prints untouched (they're trimmed or sit on the backdrop anyway).
 */
export function fabricField(rgb: ArrayLike<number>, channels: number, fabric: ArrayLike<number>, fabricStride: number, width: number, height: number): FabricField {
  const n = width * height;
  const onFabric = (p: number) => (fabric[p * fabricStride] ?? 0) >= 128;
  const light = new Float32Array(n);
  const values: number[] = [];
  for (let p = 0; p < n; p += 1) {
    const i = p * channels;
    light[p] = brightness(rgb[i] ?? 0, rgb[i + 1] ?? 0, rgb[i + 2] ?? 0);
    if (onFabric(p) && p % 7 === 0) values.push(light[p] ?? 0);
  }
  values.sort((a, b) => a - b);
  const median = Math.max(0.05, values[Math.floor(values.length / 2)] ?? 0.5);

  const folds = blur(light, width, height, Math.max(1, Math.round(width * 0.012)));
  const soft = blur(light, width, height, Math.max(1, Math.round(width * 0.002)));
  const maxShift = MAX_FOLD_SHIFT * width;
  const strength = FOLD_STRENGTH * width;

  const sourceX = new Float32Array(n);
  const sourceY = new Float32Array(n);
  const shade = new Float32Array(n);
  // The body's extent per row, smoothed over a band of rows: the wrap follows the body's overall shape,
  // not every notch (a belt, a sleeve hem, a narrow waist).
  const centres = new Float32Array(height);
  const radii = new Float32Array(height);
  const has = new Float32Array(height);
  for (let y = 0; y < height; y += 1) {
    let first = -1;
    let last = -1;
    for (let x = 0; x < width; x += 1) {
      if (onFabric(y * width + x)) {
        if (first < 0) first = x;
        last = x;
      }
    }
    if (first >= 0) {
      centres[y] = (first + last) / 2;
      radii[y] = (last - first) / 2;
      has[y] = 1;
    }
  }
  const band = Math.max(1, Math.round(height * 0.06));
  const smoothCentre = new Float32Array(height);
  const smoothRadius = new Float32Array(height);
  for (let y = 0; y < height; y += 1) {
    let c = 0;
    let r = 0;
    let count = 0;
    for (let k = Math.max(0, y - band); k <= Math.min(height - 1, y + band); k += 1) {
      if (!has[k]) continue;
      c += centres[k] ?? 0;
      r += radii[k] ?? 0;
      count += 1;
    }
    smoothCentre[y] = count > 0 ? c / count : width / 2;
    smoothRadius[y] = count > 0 ? r / count : 0;
  }

  for (let y = 0; y < height; y += 1) {
    const centre = smoothCentre[y] ?? width / 2;
    const radius = smoothRadius[y] ?? 0;
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      if (!onFabric(p) || radius < 2) {
        sourceX[p] = x;
        sourceY[p] = y;
        shade[p] = 1;
        continue;
      }
      // Wrap: the flat print's coordinate that lands here on a cylinder seen from the front.
      const u = Math.max(-0.98, Math.min(0.98, (x - centre) / radius));
      const wrapped = centre + radius * ((1 - WRAP) * u + WRAP * Math.asin(u));
      // Folds: shift along the slope of the smoothed brightness.
      const gx = ((folds[y * width + Math.min(width - 1, x + 1)] ?? 0) - (folds[y * width + Math.max(0, x - 1)] ?? 0)) / 2;
      const gy = ((folds[Math.min(height - 1, y + 1) * width + x] ?? 0) - (folds[Math.max(0, y - 1) * width + x] ?? 0)) / 2;
      sourceX[p] = wrapped + Math.max(-maxShift, Math.min(maxShift, gx * strength));
      sourceY[p] = y + Math.max(-maxShift, Math.min(maxShift, gy * strength));
      shade[p] = Math.max(SHADE_MIN, Math.min(SHADE_MAX, (soft[p] ?? median) / median));
    }
  }
  return { width, height, sourceX, sourceY, shade };
}

/**
 * Applies the field to flat RGBA layers of the field's size: each output pixel samples the layers
 * (bilinear) where the field says, and its colour is shaded. Writes into `out` (RGBA, same size).
 */
export function applyFabricField(layers: ArrayLike<number>, out: { [index: number]: number; length: number }, field: FabricField): void {
  const { width, height, sourceX, sourceY, shade } = field;
  const sample = (x: number, y: number, k: number) => layers[(y * width + x) * 4 + k] ?? 0;
  for (let p = 0; p < width * height; p += 1) {
    const sx = Math.max(0, Math.min(width - 1.001, sourceX[p] ?? 0));
    const sy = Math.max(0, Math.min(height - 1.001, sourceY[p] ?? 0));
    const x0 = Math.floor(sx);
    const y0 = Math.floor(sy);
    const fx = sx - x0;
    const fy = sy - y0;
    const o = p * 4;
    // Premultiplied bilinear sampling, so transparent edges don't bleed dark fringes.
    let alpha = 0;
    const colour = [0, 0, 0];
    for (const [dx, dy, weight] of [
      [0, 0, (1 - fx) * (1 - fy)],
      [1, 0, fx * (1 - fy)],
      [0, 1, (1 - fx) * fy],
      [1, 1, fx * fy],
    ] as const) {
      const a = sample(x0 + dx, y0 + dy, 3) * weight;
      alpha += a;
      for (let k = 0; k < 3; k += 1) colour[k] = (colour[k] ?? 0) + sample(x0 + dx, y0 + dy, k) * a;
    }
    const factor = shade[p] ?? 1;
    for (let k = 0; k < 3; k += 1) out[o + k] = alpha > 0 ? Math.min(255, Math.round(((colour[k] ?? 0) / alpha) * factor)) : 0;
    out[o + 3] = Math.round(alpha);
  }
}
