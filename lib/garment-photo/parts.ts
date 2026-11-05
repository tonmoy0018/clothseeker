import { emptyMask, toLab, type GarmentParts, type Mask, type RgbImage } from "./segment";

// A customer's own garment, split into ITS parts (lib/own-dress): the AI names the parts and gives each a
// box and its colour (it can't draw reliable outlines); here every garment pixel goes to the part that
// best explains it. Within the parts' boxes, a pixel goes to the closest colour (a white shirt inside an
// open black jacket). Where colours match, the shape-based split (sleeves, bodice, skirt) and the
// smaller box decide (a waistband over a skirt). Garment pixels outside every box (a mannequin's neck,
// trousers under a jacket) are left out. Pure, so it's unit-tested.

export type PartBox = { top: number; left: number; bottom: number; right: number };
export type PartHint = { label: string; box: PartBox; hex: string };

/** What the shape-based split calls the part a label names, if anything. */
export function partKind(label: string): "sleeves" | "bodice" | "skirt" | null {
  const l = label.toLowerCase();
  if (/sleeve|strap|cuff|arm/.test(l)) return "sleeves";
  if (/skirt|tier|hem|peplum|train/.test(l)) return "skirt";
  if (/bodice|body|top|torso|yoke|chest|front/.test(l)) return "bodice";
  return null;
}

/**
 * Whether each hint can be told apart. A small part inside a bigger one of the same colour has nothing
 * but its box to go by, and would come out as a rectangle: it's folded into the bigger part, unless it's
 * a band across it (a waistband, a belt, a border), whose box is its shape.
 */
export function separableHints(hints: readonly PartHint[]): boolean[] {
  const area = (b: PartBox) => Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top);
  const overlap = (a: PartBox, b: PartBox) => area({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
  const lab = (hex: string) => {
    const n = Number.parseInt(hex.slice(1), 16);
    return toLab((n >> 16) & 255, (n >> 8) & 255, n & 255);
  };
  return hints.map((hint, i) => {
    if (partKind(hint.label)) return true;
    const own = area(hint.box);
    return !hints.some((other, j) => {
      if (j === i || area(other.box) <= own || overlap(hint.box, other.box) < own * 0.8) return false;
      const [l1, a1, b1] = lab(hint.hex);
      const [l2, a2, b2] = lab(other.hex);
      const sameColour = Math.hypot((l1 - l2) * 0.5, a1 - a2, b1 - b2) < 15;
      const band = hint.box.right - hint.box.left >= (other.box.right - other.box.left) * 0.7 && hint.box.bottom - hint.box.top <= (other.box.bottom - other.box.top) * 0.15;
      return sameColour && !band;
    });
  });
}

/** How far a part's box may be missed by, as a share of the picture. */
const BOX_SLACK = 0.015;
/** Lab distance a mismatching shape-based part counts as (colour usually decides first). */
const SHAPE_PENALTY = 18;
/** How much a larger box counts against a part (smaller, more specific parts win ties). */
const AREA_PENALTY = 8;
/** Parts smaller than this share of the garment are folded into their neighbours. */
const MIN_SHARE = 0.01;

/**
 * Splits `garment` (at `image`'s size) into one mask per hint, in the hints' order (empty for a part
 * that got nothing), and returns the garment as kept: only pixels inside some part's box.
 */
export function assignParts(image: RgbImage, garment: Mask, shapes: Pick<GarmentParts, "sleeves" | "bodice" | "skirt">, hints: readonly PartHint[]): { parts: Mask[]; garment: Mask } {
  const { width, height } = garment;
  const colours = hints.map((h) => {
    const n = Number.parseInt(h.hex.slice(1), 16);
    return toLab((n >> 16) & 255, (n >> 8) & 255, n & 255);
  });
  const kinds = hints.map((h) => partKind(h.label));
  const areas = hints.map((h) => Math.max(1e-6, (h.box.right - h.box.left) * (h.box.bottom - h.box.top)));
  const largest = Math.max(...areas);
  const inBox = (k: number, x: number, y: number, slack: number) => {
    const b = hints[k]?.box;
    if (!b) return false;
    const fx = x / width;
    const fy = y / height;
    return fx >= b.left - slack && fx <= b.right + slack && fy >= b.top - slack && fy <= b.bottom + slack;
  };
  // Each garment pixel's colour, once.
  const lab = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    if (!garment.data[i]) continue;
    const [l, a, b] = toLab(image.data[i * 3] ?? 0, image.data[i * 3 + 1] ?? 0, image.data[i * 3 + 2] ?? 0);
    lab[i * 3] = l;
    lab[i * 3 + 1] = a;
    lab[i * 3 + 2] = b;
  }
  const shapeAt = (i: number): "sleeves" | "bodice" | "skirt" | null =>
    shapes.sleeves.data[i] ? "sleeves" : shapes.skirt.data[i] ? "skirt" : shapes.bodice.data[i] ? "bodice" : null;

  /** Best part for each garment pixel among `allowed`, or -1 (outside every box). */
  const assign = (allowed: readonly boolean[]): Int16Array => {
    const labels = new Int16Array(width * height).fill(-1);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        if (!garment.data[i]) continue;
        const l = lab[i * 3] ?? 0;
        const a = lab[i * 3 + 1] ?? 0;
        const b = lab[i * 3 + 2] ?? 0;
        const shape = shapeAt(i);
        let best = -1;
        let bestCost = Infinity;
        for (let k = 0; k < hints.length; k += 1) {
          if (!allowed[k] || !inBox(k, x, y, BOX_SLACK)) continue;
          const c = colours[k] ?? [0, 0, 0];
          let cost = Math.hypot((l - c[0]) * 0.5, a - c[1], b - c[2]);
          const kind = kinds[k];
          if (kind && shape && kind !== shape) cost += SHAPE_PENALTY;
          cost += AREA_PENALTY * ((areas[k] ?? 0) / largest);
          if (cost < bestCost) {
            bestCost = cost;
            best = k;
          }
        }
        labels[i] = best;
      }
    }
    return labels;
  };

  let allowed = separableHints(hints);
  let labels = assign(allowed);
  // Parts that end up as specks are folded into the others.
  for (let round = 0; round < hints.length; round += 1) {
    const counts = new Array<number>(hints.length).fill(0);
    let total = 0;
    for (const k of labels) {
      if (k >= 0) {
        counts[k] = (counts[k] ?? 0) + 1;
        total += 1;
      }
    }
    const tiny = counts.findIndex((n, k) => allowed[k] && n > 0 && n < total * MIN_SHARE);
    if (tiny < 0) break;
    allowed = allowed.map((v, k) => v && k !== tiny);
    labels = assign(allowed);
  }
  labels = majority(labels, width, height, hints.length);

  const parts = hints.map(() => emptyMask(width, height));
  const kept = emptyMask(width, height);
  for (let i = 0; i < labels.length; i += 1) {
    const k = labels[i] ?? -1;
    if (k < 0) continue;
    const mask = parts[k];
    if (mask) mask.data[i] = 1;
    kept.data[i] = 1;
  }
  return { parts, garment: kept };
}

/** Smooths part edges: each labelled pixel takes the most common label in its 5×5 neighbourhood. */
function majority(labels: Int16Array, width: number, height: number, count: number): Int16Array {
  const out = Int16Array.from(labels);
  const votes = new Array<number>(count).fill(0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if ((labels[i] ?? -1) < 0) continue;
      votes.fill(0);
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
          const k = labels[yy * width + xx] ?? -1;
          if (k >= 0) votes[k] = (votes[k] ?? 0) + 1;
        }
      }
      let best = labels[i] ?? -1;
      for (let k = 0; k < count; k += 1) if ((votes[k] ?? 0) > (votes[best] ?? 0)) best = k;
      out[i] = best;
    }
  }
  return out;
}
