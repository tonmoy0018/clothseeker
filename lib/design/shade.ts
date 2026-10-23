// Recolouring a garment PHOTO (template `recolor: "shade"`): the new colour takes the photo's light and
// shadow. A dark navy dress can become pale pink, which multiplying can't do. Each pixel's brightness is
// stretched between the region's darkest and brightest fabric (2nd and 98th percentile), then scales
// the new colour from SHADE_MIN (deep folds) to SHADE_MAX (highlights).
// Pure and shared by the server renderer and the browser preview, so both paint the same pixels.

const SHADE_MIN = 0.45;
const SHADE_MAX = 1.05;
const MIN_SPREAD = 0.06;

export type ShadeRange = { low: number; high: number };

/** Perceived brightness (0–1) of an sRGB pixel. */
export function luminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Brightness range of the fabric under a mask. `rgb` has `channels` values per pixel (3 or 4);
 * `mask` has one value per pixel at `maskStride` (1 for a grey mask, 4 for RGBA image data).
 */
export function shadeRange(rgb: ArrayLike<number>, channels: number, mask: ArrayLike<number>, maskStride: number): ShadeRange {
  const histogram = new Uint32Array(256);
  let count = 0;
  const pixels = Math.floor(rgb.length / channels);
  for (let p = 0; p < pixels; p += 1) {
    if ((mask[p * maskStride] ?? 0) < 128) continue;
    const i = p * channels;
    const bin = Math.min(255, Math.round(luminance(rgb[i] ?? 0, rgb[i + 1] ?? 0, rgb[i + 2] ?? 0) * 255));
    histogram[bin] = (histogram[bin] ?? 0) + 1;
    count += 1;
  }
  if (count === 0) return { low: 0, high: 1 };
  const at = (fraction: number) => {
    const target = count * fraction;
    let seen = 0;
    for (let v = 0; v < 256; v += 1) {
      seen += histogram[v] ?? 0;
      if (seen >= target) return v / 255;
    }
    return 1;
  };
  const low = at(0.02);
  const high = at(0.98);
  if (high - low >= MIN_SPREAD) return { low, high };
  // Nearly flat fabric: place it high in a minimal range, so it shows close to the true colour.
  const middle = (low + high) / 2;
  return { low: middle - 0.7 * MIN_SPREAD, high: middle + 0.3 * MIN_SPREAD };
}

/** The factor applied to the new colour at a pixel of this brightness. */
export function shadeFactor(brightness: number, range: ShadeRange): number {
  const t = Math.min(1, Math.max(0, (brightness - range.low) / (range.high - range.low)));
  return SHADE_MIN + (SHADE_MAX - SHADE_MIN) * t;
}

/** One channel of the new colour, shaded and clamped to 0–255. */
export function shadeChannel(value: number, factor: number): number {
  return Math.min(255, Math.round(value * factor));
}
