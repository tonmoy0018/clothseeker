import { toLab, type Mask, type RgbImage } from "@/lib/garment-photo/segment";

// Parts of a garment the garment finder misses because they aren't the garment's main colour: a pale
// placket, an embroidered or contrasting collar band, embroidery. Left out, the live mirror shows the
// person's own clothes through them. Also the backdrop's colour caught at the garment's edge. Pure (on
// pixel arrays), so it's unit-tested.

/** Clearly coloured: not a grey, cream or white backdrop or mannequin, not a shadow, not a metal stand. */
function coloured(lab: [number, number, number]): boolean {
  return Math.hypot(lab[1], lab[2]) >= 14;
}

/**
 * The garment mask grown into coloured pixels it touches, between its widest sides, from a collar's
 * height above its top down to `untilY` (its hem); then notches a few pixels wide are sealed and small
 * enclosed specks (buttons) filled. Greys stop the growing, so an open neckline showing a mannequin,
 * shadows between a sleeve and the body, and the backdrop stay out. Sealed pixels that show the
 * backdrop take the colour of the fabric around them (this changes `image`).
 */
export function recoverGarment(image: RgbImage, garment: Mask, untilY: number): Mask {
  const { width, height } = garment;
  let top = height;
  for (let p = 0; p < width * height && top === height; p += 1) if (garment.data[p]) top = Math.floor(p / width);
  if (top === height) return garment;
  // Its sides: the widest garment extent between the top and untilY.
  let left = width;
  let right = -1;
  const bottom = Math.min(height - 1, Math.max(top, Math.round(untilY)));
  for (let y = top; y <= bottom; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!garment.data[y * width + x]) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
    }
  }
  const from = Math.max(0, top - Math.round((right - left) * 0.06));
  const inside = (x: number, y: number) => x >= left && x <= right && y >= from && y <= bottom;
  const out = { data: Uint8Array.from(garment.data), width, height };
  const fabricLike = (p: number) => coloured(toLab(image.data[p * 3] ?? 0, image.data[p * 3 + 1] ?? 0, image.data[p * 3 + 2] ?? 0));
  const stack: number[] = [];
  for (let y = from; y <= bottom; y += 1) for (let x = left; x <= right; x += 1) if (out.data[y * width + x]) stack.push(y * width + x);
  while (stack.length > 0) {
    const p = stack.pop() ?? 0;
    const x = p % width;
    const y = Math.floor(p / width);
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ] as const) {
      if (!inside(nx, ny)) continue;
      const q = ny * width + nx;
      if (out.data[q] || !fabricLike(q)) continue;
      out.data[q] = 1;
      stack.push(q);
    }
  }
  // Notches up to about 1% of the picture wide are sealed (a bright highlight taken for backdrop), then
  // enclosed specks. Wider would bridge an open V-neck or join a hanging sleeve to the body.
  const radius = Math.max(1, Math.round(width / 200));
  const sealed = fillSpecks(closeMask(out, radius), Math.round(width * height * 0.0005));
  recolourBackdrop(image, sealed, radius * 2);
  return sealed;
}

/** The backdrop's colour: the median of the picture's border pixels, in Lab. */
function backdropLab(image: RgbImage): [number, number, number] {
  const { width, height } = image;
  const samples: [number, number, number][] = [];
  for (let x = 0; x < width; x += 4) for (const y of [0, height - 1]) samples.push(labAt(image, y * width + x));
  for (let y = 0; y < height; y += 4) for (const x of [0, width - 1]) samples.push(labAt(image, y * width + x));
  const median = (k: 0 | 1 | 2) => [...samples].sort((a, b) => a[k] - b[k])[Math.floor(samples.length / 2)]?.[k] ?? 0;
  return [median(0), median(1), median(2)];
}

function labAt(image: RgbImage, p: number): [number, number, number] {
  return toLab(image.data[p * 3] ?? 0, image.data[p * 3 + 1] ?? 0, image.data[p * 3 + 2] ?? 0);
}

/**
 * Garment pixels within `reach` of the outline that have the backdrop's colour (sealed notches, the
 * backdrop caught at the garment's edge) take the average colour of the nearby garment pixels that
 * don't. Mapped onto a person close to the camera they'd show as pale patches. Changes `image`.
 */
export function recolourBackdrop(image: RgbImage, garment: Mask, reach: number): void {
  const { width, height } = garment;
  const backdrop = backdropLab(image);
  const isBackdrop = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p += 1) {
    if (!garment.data[p]) continue;
    const lab = labAt(image, p);
    isBackdrop[p] = Math.hypot(lab[0] - backdrop[0], lab[1] - backdrop[1], lab[2] - backdrop[2]) <= 12 ? 1 : 0;
  }
  const near = (x0: number, y0: number, test: (q: number) => boolean) => {
    for (let y = Math.max(0, y0 - reach); y <= Math.min(height - 1, y0 + reach); y += 1) {
      for (let x = Math.max(0, x0 - reach); x <= Math.min(width - 1, x0 + reach); x += 1) if (test(y * width + x)) return true;
    }
    return false;
  };
  const colours = new Map<number, [number, number, number]>();
  for (let p = 0; p < width * height; p += 1) {
    if (!isBackdrop[p]) continue;
    const x0 = p % width;
    const y0 = Math.floor(p / width);
    if (!near(x0, y0, (q) => !garment.data[q])) continue;
    const sum = [0, 0, 0];
    let count = 0;
    for (let y = Math.max(0, y0 - reach * 2); y <= Math.min(height - 1, y0 + reach * 2); y += 1) {
      for (let x = Math.max(0, x0 - reach * 2); x <= Math.min(width - 1, x0 + reach * 2); x += 1) {
        const q = y * width + x;
        if (!garment.data[q] || isBackdrop[q]) continue;
        for (let k = 0; k < 3; k += 1) sum[k] = (sum[k] ?? 0) + (image.data[q * 3 + k] ?? 0);
        count += 1;
      }
    }
    if (count > 0) colours.set(p, [Math.round((sum[0] ?? 0) / count), Math.round((sum[1] ?? 0) / count), Math.round((sum[2] ?? 0) / count)]);
  }
  for (const [p, rgb] of colours) for (let k = 0; k < 3; k += 1) image.data[p * 3 + k] = rgb[k] ?? 0;
}

/** Square dilation (or erosion) by `radius`, done as two 1-D passes. */
function morph(mask: Mask, radius: number, grow: boolean): Mask {
  const { width, height } = mask;
  const pass = (input: Uint8Array, horizontal: boolean) => {
    const output = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let hit = !grow;
        for (let d = -radius; d <= radius && hit !== grow; d += 1) {
          const nx = horizontal ? x + d : x;
          const ny = horizontal ? y : y + d;
          const v = nx >= 0 && ny >= 0 && nx < width && ny < height ? input[ny * width + nx] : 0;
          if (grow ? v : !v) hit = grow;
        }
        output[y * width + x] = hit ? 1 : 0;
      }
    }
    return output;
  };
  return { data: pass(pass(mask.data, true), false), width, height };
}

/** Morphological closing: seals notches and holes up to about twice `radius` across, keeping the outline. */
export function closeMask(mask: Mask, radius: number): Mask {
  const closed = morph(morph(mask, radius, true), radius, false);
  // Never remove what was there (erosion at the picture's border).
  for (let p = 0; p < closed.data.length; p += 1) if (mask.data[p]) closed.data[p] = 1;
  return closed;
}

/** Fills holes (areas cut off from the picture's border) of at most `maxArea` pixels. */
export function fillSpecks(mask: Mask, maxArea: number): Mask {
  const { width, height } = mask;
  const seen = new Uint8Array(width * height);
  const out = { data: Uint8Array.from(mask.data), width, height };
  for (let start = 0; start < width * height; start += 1) {
    if (seen[start] || mask.data[start]) continue;
    const region: number[] = [];
    let touchesBorder = false;
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const p = stack.pop() ?? 0;
      region.push(p);
      const x = p % width;
      if (x === 0 || x === width - 1 || p < width || p >= width * (height - 1)) touchesBorder = true;
      for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width]) {
        if (q >= 0 && q < width * height && !seen[q] && !mask.data[q]) {
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    if (!touchesBorder && region.length <= maxArea) for (const p of region) out.data[p] = 1;
  }
  return out;
}
