// Finds the dress in a catalogue photo (dress on a mannequin, plain studio background) and splits it
// into sleeves, bodice and skirt, so photos can be recoloured part by part.
// Pure functions over raw RGB pixels: no I/O, deterministic, unit-testable.

export type RgbImage = { data: Uint8Array; width: number; height: number };
export type Mask = { data: Uint8Array; width: number; height: number };

export type GarmentParts = {
  garment: Mask;
  sleeves: Mask;
  bodice: Mask;
  skirt: Mask;
  /** Measurements in pixels of the input image. */
  shoulderY: number;
  waistY: number;
  hemY: number;
  centreX: number;
  /** Lowest row reached by a sleeve, or null when there are no sleeves. */
  sleeveBottomY: number | null;
};

export class SegmentationError extends Error {
  override readonly name = "SegmentationError";
}

// ─── colour ──────────────────────────────────────────────────────────────────

type Lab = [number, number, number];

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function toLab(r: number, g: number, b: number): Lab {
  const [lr, lg, lb] = [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
  const x = (0.4124 * lr + 0.3576 * lg + 0.1805 * lb) / 0.95047;
  const y = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  const z = (0.0193 * lr + 0.1192 * lg + 0.9505 * lb) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function labImage(image: RgbImage): Float32Array {
  const n = image.width * image.height;
  const lab = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    const [l, a, b] = toLab(image.data[i * 3] ?? 0, image.data[i * 3 + 1] ?? 0, image.data[i * 3 + 2] ?? 0);
    lab[i * 3] = l;
    lab[i * 3 + 1] = a;
    lab[i * 3 + 2] = b;
  }
  return lab;
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

// ─── masks ───────────────────────────────────────────────────────────────────

export function emptyMask(width: number, height: number): Mask {
  return { data: new Uint8Array(width * height), width, height };
}

export function maskArea(mask: Mask): number {
  let area = 0;
  for (const v of mask.data) if (v) area += 1;
  return area;
}

/** Keeps only the largest 4-connected component of `mask`. */
function largestComponent(mask: Mask): Mask {
  const { width, height } = mask;
  const labels = new Int32Array(width * height);
  const stack: number[] = [];
  let best = 0;
  let bestSize = 0;
  let label = 0;
  for (let start = 0; start < mask.data.length; start += 1) {
    if (!mask.data[start] || labels[start]) continue;
    label += 1;
    let size = 0;
    stack.push(start);
    labels[start] = label;
    while (stack.length > 0) {
      const i = stack.pop() ?? 0;
      size += 1;
      const x = i % width;
      for (const j of [i - width, i + width, x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1]) {
        if (j >= 0 && j < mask.data.length && mask.data[j] && !labels[j]) {
          labels[j] = label;
          stack.push(j);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = label;
    }
  }
  const out = emptyMask(width, height);
  for (let i = 0; i < out.data.length; i += 1) out.data[i] = labels[i] === best ? 1 : 0;
  return out;
}

/**
 * Fills enclosed holes smaller than `maxHole` pixels (seams, buttons, shadows inside the dress). Kept
 * small, so the background showing between a hanging sleeve and the body stays open.
 */
function fillSmallHoles(mask: Mask, maxHole: number): Mask {
  const { width, height } = mask;
  const out = { ...mask, data: Uint8Array.from(mask.data) };
  const seen = new Uint8Array(width * height);
  const stack: number[] = [];
  for (let start = 0; start < mask.data.length; start += 1) {
    if (mask.data[start] || seen[start]) continue;
    const region: number[] = [];
    let touchesEdge = false;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const i = stack.pop() ?? 0;
      region.push(i);
      const x = i % width;
      const y = Math.floor(i / width);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;
      for (const j of [i - width, i + width, x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1]) {
        if (j >= 0 && j < mask.data.length && !mask.data[j] && !seen[j]) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    if (!touchesEdge && region.length <= maxHole) {
      for (const i of region) out.data[i] = 1;
    }
  }
  return out;
}

/** Removes specks: a pixel stays only if most of its 3×3 neighbourhood agrees. */
function smooth(mask: Mask): Mask {
  const { width, height } = mask;
  const out = emptyMask(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let on = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = Math.min(width - 1, Math.max(0, x + dx));
          const yy = Math.min(height - 1, Math.max(0, y + dy));
          on += mask.data[yy * width + xx] ?? 0;
        }
      }
      out.data[y * width + x] = on >= 5 ? 1 : 0;
    }
  }
  return out;
}

// ─── finding the dress ───────────────────────────────────────────────────────

/** Least-squares plane v = c0 + c1·x + c2·y through the samples (studio backgrounds are gradients). */
function fitPlane(samples: readonly [number, number, number][]): [number, number, number] {
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sv = 0, sxv = 0, syv = 0;
  for (const [x, y, v] of samples) {
    n += 1; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sv += v; sxv += x * v; syv += y * v;
  }
  // Solve the 3×3 normal equations with Cramer's rule.
  const det3 = (a: number[]) =>
    (a[0] ?? 0) * ((a[4] ?? 0) * (a[8] ?? 0) - (a[5] ?? 0) * (a[7] ?? 0)) -
    (a[1] ?? 0) * ((a[3] ?? 0) * (a[8] ?? 0) - (a[5] ?? 0) * (a[6] ?? 0)) +
    (a[2] ?? 0) * ((a[3] ?? 0) * (a[7] ?? 0) - (a[4] ?? 0) * (a[6] ?? 0));
  const m = [n, sx, sy, sx, sxx, sxy, sy, sxy, syy];
  const d = det3(m);
  if (Math.abs(d) < 1e-9) return [sv / Math.max(1, n), 0, 0];
  const col = (k: number) => m.map((v, i) => (i % 3 === k ? [sv, sxv, syv][Math.floor(i / 3)] ?? 0 : v));
  return [det3(col(0)) / d, det3(col(1)) / d, det3(col(2)) / d];
}

/** Drops thin rows at the top and bottom (mannequin neck knob, stand pole) that match the dress colour. */
function trimThinEnds(mask: Mask): Mask {
  const { width, height } = mask;
  const widths: number[] = [];
  for (let y = 0; y < height; y += 1) {
    let w = 0;
    for (let x = 0; x < width; x += 1) w += mask.data[y * width + x] ?? 0;
    widths.push(w);
  }
  const widest = Math.max(...widths);
  const widestY = widths.indexOf(widest);
  const thin = widest * 0.14;
  const out = { ...mask, data: Uint8Array.from(mask.data) };
  // Below the dress: the first thin row under the widest part starts the stand.
  for (let y = widestY; y < height; y += 1) {
    if ((widths[y] ?? 0) < thin) {
      out.data.fill(0, y * width);
      break;
    }
  }
  // Above it: clear thin rows from the top until the dress gets wide.
  for (let y = 0; y < widestY; y += 1) {
    if ((widths[y] ?? 0) >= thin) break;
    out.data.fill(0, y * width, (y + 1) * width);
  }
  return out;
}

/**
 * The dress as a mask. The background is modelled from the image border (as a gentle gradient); the
 * dress colour comes from the central column, between the mannequin's neck and its stand. A pixel is
 * dress when it stands out from the background and is close to the dress colour. Lightness counts
 * for little, so folds and shadows stay in and pale dresses are told apart by their tint.
 */
export function findGarment(image: RgbImage): Mask {
  const { width, height } = image;
  const lab = labImage(image);
  const at = (x: number, y: number) => (y * width + x) * 3;

  const border: [number, number, number][][] = [[], [], []];
  const edge = Math.max(2, Math.round(Math.min(width, height) * 0.03));
  for (let y = 0; y < height; y += 3) {
    for (let x = 0; x < width; x += 3) {
      if (x < edge || y < edge || x >= width - edge || y >= height - edge) {
        for (let k = 0; k < 3; k += 1) border[k]?.push([x / width, y / height, lab[at(x, y) + k] ?? 0]);
      }
    }
  }
  const planes = border.map(fitPlane);
  const bgAt = (x: number, y: number, k: number) => {
    const [c0, c1, c2] = planes[k] ?? [0, 0, 0];
    return c0 + c1 * (x / width) + c2 * (y / height);
  };
  const toBg = (x: number, y: number) => {
    const i = at(x, y);
    return Math.hypot(((lab[i] ?? 0) - bgAt(x, y, 0)) * 0.4, (lab[i + 1] ?? 0) - bgAt(x, y, 1), (lab[i + 2] ?? 0) - bgAt(x, y, 2));
  };

  // Central column: what differs from the background; the middle of its extent is dress.
  const column: number[] = [];
  const x0 = Math.round(width * 0.48);
  const x1 = Math.round(width * 0.52);
  for (let y = 0; y < height; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (toBg(x, y) > 5) column.push(y);
    }
  }
  if (column.length < height * 0.05) throw new SegmentationError("No dress found in the middle of the photo");
  const top = column[Math.floor(column.length * 0.35)] ?? 0;
  const bottom = column[Math.floor(column.length * 0.65)] ?? height;
  const samples: number[][] = [[], [], []];
  for (let y = top; y <= bottom; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (toBg(x, y) > 5) for (let k = 0; k < 3; k += 1) samples[k]?.push(lab[at(x, y) + k] ?? 0);
    }
  }
  const dress = samples.map(median);
  const dressL = dress[0] ?? 0;
  const contrast = Math.hypot((dressL - bgAt(0.5 * width, 0.5 * height, 0)) * 0.4, (dress[1] ?? 0) - bgAt(0.5 * width, 0.5 * height, 1), (dress[2] ?? 0) - bgAt(0.5 * width, 0.5 * height, 2));
  const bgThreshold = Math.max(4, contrast * 0.4);
  // Colourless fabric (black, white) can only be told apart by its lightness; coloured fabric by its tint.
  const dressChroma = Math.hypot(dress[1] ?? 0, dress[2] ?? 0);
  const lightnessWeight = dressChroma < 12 ? 0.6 : dressL < 35 ? 0.15 : 0.3;
  const dressThreshold = Math.max(8, Math.min(28, contrast * 0.85));

  const mask = emptyMask(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = at(x, y);
      const toDress = Math.hypot(((lab[i] ?? 0) - dressL) * lightnessWeight, (lab[i + 1] ?? 0) - (dress[1] ?? 0), (lab[i + 2] ?? 0) - (dress[2] ?? 0));
      mask.data[y * width + x] = toBg(x, y) > bgThreshold && toDress < dressThreshold ? 1 : 0;
    }
  }
  // Closing fills notches along the edge (highlights on pale fabric); gaps beside hanging sleeves are wider.
  const radius = Math.max(1, Math.round(width / 200));
  const garment = fillSmallHoles(close(largestComponent(trimThinEnds(largestComponent(smooth(mask)))), radius), Math.round(width * height * 0.004));
  if (maskArea(garment) < width * height * 0.03) throw new SegmentationError("The dress is too small or wasn't found");
  return garment;
}

// ─── splitting into parts ────────────────────────────────────────────────────

type Run = { from: number; to: number };

function runs(mask: Mask, y: number): Run[] {
  const out: Run[] = [];
  let from = -1;
  for (let x = 0; x <= mask.width; x += 1) {
    const on = x < mask.width && mask.data[y * mask.width + x] === 1;
    if (on && from < 0) from = x;
    if (!on && from >= 0) {
      out.push({ from, to: x - 1 });
      from = -1;
    }
  }
  return out;
}

/** Morphological closing (dilate, then erode) with a square of radius `r`: fills nicks along the edge. */
function close(mask: Mask, r: number): Mask {
  const pass = (src: Mask, grow: boolean): Mask => {
    const { width, height } = src;
    const horizontal = emptyMask(width, height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let v = grow ? 0 : 1;
        for (let dx = -r; dx <= r; dx += 1) {
          const xx = Math.min(width - 1, Math.max(0, x + dx));
          const on = src.data[y * width + xx] ?? 0;
          v = grow ? Math.max(v, on) : Math.min(v, on);
        }
        horizontal.data[y * width + x] = v;
      }
    }
    const out = emptyMask(width, height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let v = grow ? 0 : 1;
        for (let dy = -r; dy <= r; dy += 1) {
          const yy = Math.min(height - 1, Math.max(0, y + dy));
          const on = horizontal.data[yy * width + x] ?? 0;
          v = grow ? Math.max(v, on) : Math.min(v, on);
        }
        out.data[y * width + x] = v;
      }
    }
    return out;
  };
  return pass(pass(mask, true), false);
}

/**
 * Splits the dress into sleeves, bodice and skirt.
 * - The waist is the narrowest row of the body between 20% and 55% of the dress height.
 * - Each side of the body is followed upwards from the waist. Where its edge suddenly jumps outwards,
 *   a sleeve starts (a sleeve hem or the underarm); above that, the torso edge carries on straight up
 *   and whatever lies outside it is sleeve. Pieces separate from the body are sleeves too.
 * - Below the waist, pieces beside the skirt near the hips are hanging long sleeves.
 */
export function splitGarment(garment: Mask): GarmentParts {
  const { width, height } = garment;
  let shoulderY = -1;
  let hemY = -1;
  for (let y = 0; y < height; y += 1) {
    if (runs(garment, y).length > 0) {
      if (shoulderY < 0) shoulderY = y;
      hemY = y;
    }
  }
  if (shoulderY < 0) throw new SegmentationError("Empty dress mask");
  const dressHeight = hemY - shoulderY;

  // Centre line: middle of the dress's horizontal extent across its lower half.
  const centres: number[] = [];
  for (let y = shoulderY + Math.round(dressHeight * 0.5); y <= hemY; y += 2) {
    const r = runs(garment, y);
    const first = r[0];
    const last = r.at(-1);
    if (first && last) centres.push((first.from + last.to) / 2);
  }
  const centreX = Math.round(median(centres));

  /** The run that contains the centre line (the body, not separate sleeves). */
  const bodyRun = (y: number): Run | null => runs(garment, y).find((r) => r.from <= centreX && r.to >= centreX) ?? null;

  // The body's sides, followed up from the hips. The torso's side rises almost straight; where the edge
  // suddenly moves out faster than SLEEVE_SLOPE over a few rows, a sleeve starts (a cuff of a hanging
  // sleeve, a sleeve hem, the underarm), and the torso edge carries on from where it was. Above the
  // neckline (where the centre line is open) the last edges carry on too.
  const startY = shoulderY + Math.round(dressHeight * 0.62);
  const window = Math.max(4, Math.round(dressHeight * 0.02));
  /** Rows where a sleeve was found to start, per side. */
  const sleeveStart: number[] = [];
  const torsoEdge = (side: -1 | 1): Map<number, number> => {
    const edges = new Map<number, number>();
    const history: number[] = [];
    let frozen: number | null = null;
    for (let y = startY; y >= shoulderY; y -= 1) {
      const run = bodyRun(y);
      const edge = run ? (side < 0 ? run.from : run.to) : history.at(-1);
      if (edge === undefined) continue;
      history.push(edge);
      const below = history[history.length - 1 - window];
      if (frozen === null && below !== undefined && (edge - below) * side > SLEEVE_SLOPE * window + 1) {
        frozen = below; // the sleeve starts here: keep the torso edge where it was
        sleeveStart.push(y + window);
      }
      edges.set(y, frozen ?? edge);
    }
    return edges;
  };
  const left = torsoEdge(-1);
  const right = torsoEdge(1);

  // The waist: the narrowest torso row between 20% and 55% of the dress height (the lowest on a tie,
  // since estimated torso edges above a sleeve are constant).
  const waistFrom = shoulderY + Math.round(dressHeight * 0.2);
  const waistTo = shoulderY + Math.round(dressHeight * 0.55);
  let waistY = shoulderY + Math.round(dressHeight * 0.35);
  let narrowest = Number.POSITIVE_INFINITY;
  for (let y = waistTo; y >= waistFrom; y -= 1) {
    const l = left.get(y);
    const r = right.get(y);
    const w = l !== undefined && r !== undefined ? r - l : Number.POSITIVE_INFINITY;
    if (w < narrowest) {
      narrowest = w;
      waistY = y;
    }
  }
  // Long sleeves hanging over the waist (their cuffs low on the dress) hide it: estimate it a little
  // more than a shoulder width below the shoulders instead.
  if (sleeveStart.some((y) => y >= waistY - 2 && y > shoulderY + dressHeight * 0.4)) {
    const top = bodyRun(shoulderY + Math.round(dressHeight * 0.05));
    const shoulderWidth = top ? top.to - top.from : dressHeight * 0.2;
    waistY = Math.min(waistTo, Math.max(waistFrom, shoulderY + Math.round(shoulderWidth * 1.05)));
  }

  const sleeves = emptyMask(width, height);
  const bodice = emptyMask(width, height);
  const skirt = emptyMask(width, height);
  const hipLimit = waistY + (waistY - shoulderY) * 1.3;
  const continuesSleeve = (x: number, y: number) =>
    sleeves.data[(y - 1) * width + x] === 1 || (x > 0 && sleeves.data[(y - 1) * width + x - 1] === 1) || (x < width - 1 && sleeves.data[(y - 1) * width + x + 1] === 1);
  let sleeveBottomY: number | null = null;
  for (let y = shoulderY; y <= hemY; y += 1) {
    const body = bodyRun(y);
    for (const run of runs(garment, y)) {
      const isBody = body !== null && run.from === body.from && run.to === body.to;
      for (let x = run.from; x <= run.to; x += 1) {
        let part: Mask;
        if (y <= waistY) {
          const l = left.get(y) ?? centreX;
          const r = right.get(y) ?? centreX;
          part = x < l || x > r ? sleeves : bodice;
        } else {
          // Below the waist, sleeves hang outside the torso edges (touching the skirt or not), but only as
          // a continuation of a sleeve from the row above.
          const l = left.get(y);
          const r = right.get(y);
          const outside = !isBody || (l !== undefined && x < l) || (r !== undefined && x > r);
          part = outside && y < hipLimit && continuesSleeve(x, y) ? sleeves : skirt;
        }
        part.data[y * width + x] = 1;
        if (part === sleeves) sleeveBottomY = Math.max(sleeveBottomY ?? 0, y);
      }
    }
  }
  // Tiny slivers at the armhole aren't sleeves.
  if (maskArea(sleeves) < maskArea(garment) * 0.015) {
    for (let p = 0; p < sleeves.data.length; p += 1) {
      if (sleeves.data[p]) {
        bodice.data[p] = 1;
        sleeves.data[p] = 0;
      }
    }
    sleeveBottomY = null;
  }
  return { garment, sleeves, bodice, skirt, shoulderY, waistY, hemY, centreX, sleeveBottomY };
}

// ─── reading the style back from the shape ───────────────────────────────────

/** How fast (px per row) a side edge may move outwards and still be the torso, not a sleeve. */
const SLEEVE_SLOPE = 0.75;

/**
 * Skirt length as a multiple of the bodice length (hem−waist over waist−shoulders). Comparable between
 * pictures of the same dress, which is how AI style pictures are checked against the real photo.
 */
export function skirtRatio(parts: GarmentParts): number {
  return (parts.hemY - parts.waistY) / Math.max(1, parts.waistY - parts.shoulderY);
}

/** Sleeves read from the shape: long sleeves reach well below the waist. */
export function sleeveStyle(parts: GarmentParts): "sleeveless" | "short" | "long" {
  if (parts.sleeveBottomY === null) return "sleeveless";
  return parts.sleeveBottomY > parts.waistY + 0.25 * (parts.waistY - parts.shoulderY) ? "long" : "short";
}
