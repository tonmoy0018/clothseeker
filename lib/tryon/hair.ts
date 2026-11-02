import type { Keypoint, Pose } from "@/lib/vision/movenet";

import type { PersonAt } from "./mask";

// Hair falling over the shoulders or chest, so the try-on keeps it instead of repainting it (it sits in
// front of the garment). There's no hair model on the device, so it's found by shade: the lit face by
// the nose gives the skin's lightness, the darkest tenth of the head above the eyes the hair's, and hair
// is what grows from the head in the hair's shade, through the person's pixels, down to the upper chest.
// When the hair isn't much darker than the skin (blond or grey hair, a bald head), or the growth spills
// into the neck or chest, nothing is kept and the try-on repaints as before. Pure, so it's unit-tested.

const SEEN = 0.3;
const PERSON = 0.5;
/** Hair must be at least this much darker than lit skin (CIE L*), or shade can't tell them apart. */
const MIN_CONTRAST = 18;
/** At least this share of the head above the eyes must be hair for its colour to be trusted. */
const MIN_HAIR_SHARE = 0.12;
/** More than this share of the neck's front or the chest's middle "hair": that's skin or a dark top. */
const MAX_CHEST_SHARE = 0.35;

/** CIE L* (0–100) of an sRGB colour: how light it looks. */
function lightnessOf(r: number, g: number, b: number): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/**
 * Hair to keep (1) in an RGB photo, or null when it can't be told apart from the skin or the clothes
 * (short or no hair, hair the colour of the skin, a top the colour of the hair).
 */
export function hairMask(rgb: ArrayLike<number>, width: number, height: number, pose: Pose, person: PersonAt): Uint8Array | null {
  const seen = (k: Keypoint) => k.score >= SEEN;
  const { leftEye, rightEye, nose, leftShoulder: ls, rightShoulder: rs } = pose;
  if (![leftEye, rightEye, nose, ls, rs].every(seen)) return null;
  const eyeGap = Math.abs(leftEye.x - rightEye.x);
  const span = Math.abs(ls.x - rs.x);
  if (eyeGap < 4 || span < 8) return null;
  const lightness = (x: number, y: number) => {
    const i = (Math.round(y) * width + Math.round(x)) * 3;
    return lightnessOf(rgb[i] ?? 0, rgb[i + 1] ?? 0, rgb[i + 2] ?? 0);
  };
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height;

  // The top of the head, straight up from between the eyes.
  const eyeX = (leftEye.x + rightEye.x) / 2;
  const eyeY = (leftEye.y + rightEye.y) / 2;
  let headTop = Math.round(eyeY);
  while (headTop > 0 && person(eyeX, headTop - 1) >= PERSON) headTop -= 1;
  if (eyeY - headTop < 4) return null;

  const skinValues: number[] = [];
  for (let y = Math.round(eyeY + 0.3 * (nose.y - eyeY)); y <= nose.y; y += 1) {
    for (let x = Math.round(nose.x - 0.25 * eyeGap); x <= nose.x + 0.25 * eyeGap; x += 1) {
      if (inside(x, y) && person(x, y) >= PERSON) skinValues.push(lightness(x, y));
    }
  }
  if (skinValues.length < 12) return null;
  const skinL = median(skinValues);

  // The head above the eyes: hair, forehead, maybe a gap. Its darkest tenth is the hair's shade.
  const head: { p: number; l: number }[] = [];
  for (let y = headTop; y <= eyeY; y += 1) {
    for (let x = Math.round(eyeX - 1.5 * eyeGap); x <= eyeX + 1.5 * eyeGap; x += 1) {
      if (inside(x, y) && person(x, y) >= PERSON) head.push({ p: y * width + x, l: lightness(x, y) });
    }
  }
  if (head.length < 12) return null;
  const hairL = [...head].sort((a, b) => a.l - b.l)[Math.floor(head.length * 0.1)]?.l ?? 0;
  if (skinL - hairL < MIN_CONTRAST) return null;
  // Hair is much darker than lit skin: nearer the hair's shade than the skin's (shadowed skin sits between).
  const darkest = hairL + 0.4 * (skinL - hairL);
  const isHair = (x: number, y: number) => lightness(x, y) <= darkest;
  const seeds = head.filter((h) => h.l <= darkest).map((h) => h.p);
  if (seeds.length < head.length * MIN_HAIR_SHARE) return null;

  // Grow from the head through hair-coloured person pixels, down to the upper chest.
  const shoulderY = (ls.y + rs.y) / 2;
  const lowest = Math.min(height - 1, Math.round(shoulderY + 0.8 * span));
  const out = new Uint8Array(width * height);
  const queue: number[] = [];
  for (const p of seeds) {
    const x = p % width;
    if (isHair(x, (p - x) / width)) {
      out[p] = 1;
      queue.push(p);
    }
  }
  while (queue.length > 0) {
    const p = queue.pop() ?? 0;
    const x = p % width;
    const y = (p - x) / width;
    for (const [nx, ny] of [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ] as const) {
      if (!inside(nx, ny) || ny < headTop || ny > lowest) continue;
      const q = ny * width + nx;
      if (out[q] || person(nx, ny) < PERSON || !isHair(nx, ny)) continue;
      out[q] = 1;
      queue.push(q);
    }
  }

  // Leaked into shadowed skin (the front of the neck) or a top the colour of the hair (the middle of
  // the chest): better keep nothing than keep their old top or skin in front of the garment.
  const centreX = (ls.x + rs.x) / 2;
  const share = (x0: number, x1: number, y0: number, y1: number) => {
    let all = 0;
    let filled = 0;
    for (let y = Math.round(y0); y <= y1; y += 1) {
      for (let x = Math.round(x0); x <= x1; x += 1) {
        if (!inside(x, y) || person(x, y) < PERSON) continue;
        all += 1;
        filled += out[y * width + x] ?? 0;
      }
    }
    return all > 0 ? filled / all : 0;
  };
  const neck = share(centreX - 0.12 * span, centreX + 0.12 * span, nose.y + 0.6 * (shoulderY - nose.y), shoulderY);
  const chest = share(centreX - 0.25 * span, centreX + 0.25 * span, shoulderY + 0.2 * span, Math.min(lowest, shoulderY + 0.8 * span));
  return neck > MAX_CHEST_SHARE || chest > MAX_CHEST_SHARE ? null : out;
}
