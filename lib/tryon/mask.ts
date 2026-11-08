import type { GarmentTypeInfo } from "@/lib/catalog/garment-types";
import { BODY_LEVELS } from "@/lib/fit/fit";
import type { Keypoint, Pose } from "@/lib/vision/movenet";

// The area of a customer's photo a local try-on model repaints (lib/ai/tryon-local.ts): their own
// clothes where the new garment goes. Above the hips it hugs their outline (the person mask) with a
// small margin, so the model can't draw their shoulders, sides or arms any wider than they are; below
// the hips a skirt may stand away from the legs. The face, wrists (and what's on them), hands, feet, the
// background and, when it can be told apart, hair over the shoulders are kept as they are. Built from
// the on-device body points and person mask; pure, so it's unit-tested.
//
// Tried and dropped (2026-11-02): keeping or showing the model bare arms past the sleeves, so it can't
// move them. Arms resting in front of the body then split the garment and the model drew two (a crop
// top over a denim skirt); arms beside the body got cut-off sleeves.

/** How far down the garment reaches: shirts to below the hips, panjabis to the knees, dresses to the ankles. */
export type TryOnReach = GarmentTypeInfo["tryOnReach"];

/** How likely a photo pixel (x, y) belongs to the person, 0–1. */
export type PersonAt = (x: number, y: number) => number;

const MIN_SCORE = 0.25;
/** Person-mask likelihood that counts as the person. */
const PERSON = 0.5;

type P = { x: number; y: number };

const mid = (a: P, b: P): P => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const seen = (k: Keypoint) => k.score >= MIN_SCORE;

function distanceToSegment(p: P, a: P, b: P): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** A piecewise-linear profile down the body: value at each y (clamped at both ends). */
function profile(points: readonly { y: number; v: number }[]): (y: number) => number {
  return (y) => {
    const first = points[0];
    const last = points[points.length - 1];
    if (!first || !last) return 0;
    if (y <= first.y) return first.v;
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      if (a && b && y <= b.y) return b.y === a.y ? b.v : a.v + ((b.v - a.v) * (y - a.y)) / (b.y - a.y);
    }
    return last.v;
  };
}

/**
 * How the chosen size fits (lib/fit/fit.ts): `width` scales the garment's outline (1 = as made for the
 * person, more = loose, less = tight); `hemLevel` is the hem's height above the floor as a share of the
 * person's height, or null when the garment's length isn't known.
 */
export type MaskFit = { width: number; hemLevel: number | null };

/** How far past the person's outline the garment may be drawn above the hips, in shoulder widths. */
const BODY_MARGIN = 0.06;

export type MaskOptions = {
  fit?: MaskFit;
  /** Pixels never to repaint: hair falling over the shoulders (lib/tryon/hair.ts). */
  keep?: PersonAt;
  /** Which hands are in sight (lib/tryon/hands.ts): only those are kept; a hand in a pocket is repainted. */
  hands?: { left: boolean; right: boolean };
};

/**
 * The try-on mask: 255 where the model may repaint, 0 where the photo is kept. Only the shoulders are
 * needed: hips, knees and ankles out of the picture (a half-body photo or selfie) are guessed below it,
 * and the mask simply stops at the photo's edge. Null when the shoulders aren't found.
 *
 * Above the hips (and for shirts all the way down) the mask stays within BODY_MARGIN of the person's
 * outline, so their body keeps its shape; `keep` marks other pixels never to repaint (hair falling over
 * the shoulders, lib/tryon/hair.ts).
 *
 * With a `fit`, a size too big may stand further from the body (never closer: a tight size doesn't make
 * anyone slimmer) and the mask ends where its hem lands. Below the hem the photo is kept (their own
 * legs, or what they wear on them): repainting legs alone, the model draws trousers.
 */
export function tryOnMask(
  pose: Pose,
  person: PersonAt | null,
  width: number,
  height: number,
  reach: TryOnReach,
  options: MaskOptions = {},
): Uint8Array | null {
  const { fit, keep, hands: handsInSight } = options;
  const { leftShoulder: ls, rightShoulder: rs, leftHip: lh, rightHip: rh } = pose;
  if (!seen(ls) || !seen(rs)) return null;
  const shoulders = mid(ls, rs);
  const nose = pose.nose;
  // Shoulder width; turned sideways the shoulders overlap, so it's never taken below what the head
  // height (nose to shoulders) or the torso length suggests.
  const hipsSeen = seen(lh) && seen(rh);
  const span = Math.max(
    1,
    Math.hypot(ls.x - rs.x, ls.y - rs.y),
    seen(nose) ? (shoulders.y - nose.y) * 1.6 : 0,
    hipsSeen ? (mid(lh, rh).y - shoulders.y) * 0.55 : 0,
  );
  const hips = hipsSeen ? mid(lh, rh) : { x: shoulders.x, y: shoulders.y + span * 1.5 };
  const torso = Math.max(span * 0.5, hips.y - shoulders.y);
  const hipSpan = hipsSeen ? Math.hypot(lh.x - rh.x, lh.y - rh.y) : span * 0.7;

  // Top: the lower neck (necklines and collars are redrawn), never the chin.
  const top = seen(nose) ? Math.max(nose.y + (shoulders.y - nose.y) * 0.6, shoulders.y - span * 0.35) : shoulders.y - span * 0.2;

  // Legs: guessed below the picture or from the knees when the model doesn't see them.
  const knees = seen(pose.leftKnee) && seen(pose.rightKnee) ? mid(pose.leftKnee, pose.rightKnee) : { x: hips.x, y: hips.y + torso * 0.9 };
  const ankles = seen(pose.leftAnkle) && seen(pose.rightAnkle) ? mid(pose.leftAnkle, pose.rightAnkle) : { x: knees.x, y: Math.min(height, knees.y + (knees.y - hips.y)) };
  // Dresses: a little past the ankle points, so trouser and legging cuffs are repainted too.
  const fullHem = reach === "hips" ? hips.y + torso * 0.3 : reach === "knees" ? knees.y + torso * 0.15 : ankles.y + torso * 0.1;
  // Where this size's hem lands on them (body levels → photo rows, extended past the last known point).
  const levelToY = profile([
    { y: BODY_LEVELS.shoulder, v: shoulders.y },
    { y: BODY_LEVELS.hip, v: hips.y },
    { y: BODY_LEVELS.knee, v: knees.y },
    { y: BODY_LEVELS.ankle, v: ankles.y },
  ].reverse());
  const fittedHem = fit?.hemLevel != null && fit.hemLevel > BODY_LEVELS.ankle ? levelToY(fit.hemLevel) + torso * 0.02 : null;
  const hem = fittedHem !== null ? Math.min(fullHem, Math.max(hips.y, fittedHem)) : fullHem;
  const widthScale = fit?.width ?? 1;
  const feetSpread = seen(pose.leftAnkle) && seen(pose.rightAnkle) ? Math.abs(pose.leftAnkle.x - pose.rightAnkle.x) : hipSpan;

  // The garment's widest plausible outline, left and right of the body's centre line.
  const hipHalf = Math.max(span * 0.45, hipSpan * 0.8);
  const centre = profile([
    { y: shoulders.y, v: shoulders.x },
    { y: hips.y, v: hips.x },
    { y: knees.y, v: knees.x },
    { y: ankles.y, v: ankles.x },
  ]);
  const half = profile(
    reach === "hips"
      ? [
          { y: top, v: span * 0.35 },
          { y: shoulders.y, v: span * 0.62 },
          { y: hips.y, v: hipHalf * 1.15 },
        ]
      : [
          { y: top, v: span * 0.35 },
          { y: shoulders.y, v: span * 0.62 },
          { y: hips.y, v: hipHalf * 1.2 },
          { y: hem, v: Math.max(hipHalf * 1.55, feetSpread / 2 + span * 0.35) },
        ],
  );

  // Arms, to the wrists: sleeves may be added, lengthened or removed.
  const arms: [P, P, number][] = [];
  for (const [shoulder, elbow, wrist] of [
    [ls, pose.leftElbow, pose.leftWrist],
    [rs, pose.rightElbow, pose.rightWrist],
  ] as const) {
    if (!seen(elbow)) continue;
    arms.push([shoulder, elbow, span * 0.2]);
    if (seen(wrist)) arms.push([elbow, wrist, span * 0.16]);
  }
  // Hands stay, with the wrist and what's on it (bracelets, a watch): a disc around the end of each arm.
  const hands: P[] = [];
  for (const [elbow, wrist, inSight] of [
    [pose.leftElbow, pose.leftWrist, handsInSight?.left ?? true],
    [pose.rightElbow, pose.rightWrist, handsInSight?.right ?? true],
  ] as const) {
    if (!seen(wrist) || !inSight) continue;
    const dx = seen(elbow) ? wrist.x - elbow.x : 0;
    const dy = seen(elbow) ? wrist.y - elbow.y : 1;
    const length = Math.max(1e-6, Math.hypot(dx, dy));
    hands.push({ x: wrist.x + (dx / length) * span * 0.1, y: wrist.y + (dy / length) * span * 0.1 });
  }
  const handRadius = span * 0.2;

  // Where a skirt may start standing away from the legs (dresses and panjabis only).
  const skirtFrom = reach === "hips" ? Infinity : hips.y + torso * 0.1;
  const looser = Math.max(0, widthScale - 1);

  const out = new Uint8Array(width * height);
  const onPerson = new Uint8Array(width);
  const fromPerson = new Float32Array(width);
  const bottom = Math.min(height - 1, Math.ceil(hem));
  for (let y = Math.max(0, Math.floor(top)); y <= bottom; y += 1) {
    const c = centre(y);
    let anyone = false;
    if (person) {
      for (let x = 0; x < width; x += 1) {
        onPerson[x] = person(x, y) >= PERSON ? 1 : 0;
        anyone ||= onPerson[x] === 1;
      }
    }
    // Only where the person mask found them on this row (it can miss someone the body points found).
    const followBody = anyone && y < skirtFrom;
    // Following the body, the outline is only an upper bound, never narrower than as made.
    const h = half(y) * (followBody ? Math.max(1, widthScale) : widthScale);
    if (followBody) rowDistances(onPerson, fromPerson);
    const margin = span * BODY_MARGIN + looser * half(y);
    for (let x = 0; x < width; x += 1) {
      if (followBody && (fromPerson[x] ?? Infinity) > margin) continue;
      if (keep && keep(x, y) >= PERSON) continue;
      if (hands.some((hand) => Math.hypot(x - hand.x, y - hand.y) < handRadius)) continue;
      const inOutline = Math.abs(x - c) <= h;
      const onArm = arms.some(([a, b, r]) => distanceToSegment({ x, y }, a, b) <= r);
      // Own clothes sticking out further (a wide skirt, baggy sleeves) are repainted too.
      const ownClothes = onPerson[x] === 1 && Math.abs(x - c) <= h * 1.8;
      if (inOutline || onArm || ownClothes) out[y * width + x] = 255;
    }
  }
  return out;
}

/** For each pixel of a row, how far it is (in pixels, along the row) from the nearest person pixel. */
function rowDistances(onPerson: Uint8Array, out: Float32Array): void {
  let last = -Infinity;
  for (let x = 0; x < onPerson.length; x += 1) {
    if (onPerson[x]) last = x;
    out[x] = x - last;
  }
  last = Infinity;
  for (let x = onPerson.length - 1; x >= 0; x -= 1) {
    if (onPerson[x]) last = x;
    out[x] = Math.min(out[x] ?? Infinity, last - x);
  }
}

export type Box = { left: number; top: number; width: number; height: number };

/** The bounding box of the non-zero pixels of a width×height map, or null when there are none. */
function bounds(map: ArrayLike<number>, width: number, height: number): Box | null {
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!map[y * width + x]) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return maxX < 0 ? null : { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Room left around the person in the crop, as a share of their height. */
const CROP_MARGIN = 0.08;
/** The narrowest crop (the try-on model's own picture width): a smaller one would only be enlarged. */
const MIN_CROP_WIDTH = 384;

/**
 * The 3:4 (width:height) box of the photo the try-on model sees: just around the person (`person`, the
 * whole body from the person outline) and the mask, with a margin, so they fill the model's small
 * picture as in the photos it learned from. A small figure in a wide landscape otherwise gets a few dozen
 * of its pixels, and the garment comes out blurred and wrong. The rest of the photo is kept as it is.
 * Never larger than the photo: then the largest 3:4 box that fits, centred on them.
 */
export function tryOnCrop(mask: Uint8Array, width: number, height: number, person?: Box | null): Box {
  const masked = bounds(mask, width, height);
  const parts = [masked, person ?? null].filter((b): b is Box => b !== null);
  const fullWidth = Math.min(width, Math.floor((height * 3) / 4));
  const fullHeight = Math.min(height, Math.floor((fullWidth * 4) / 3));
  if (parts.length === 0) {
    return { left: Math.floor((width - fullWidth) / 2), top: Math.floor((height - fullHeight) / 2), width: fullWidth, height: fullHeight };
  }
  const left = Math.min(...parts.map((b) => b.left));
  const top = Math.min(...parts.map((b) => b.top));
  const right = Math.max(...parts.map((b) => b.left + b.width));
  const bottom = Math.max(...parts.map((b) => b.top + b.height));
  const margin = (bottom - top) * CROP_MARGIN;
  const needW = right - left + 2 * margin;
  const needH = bottom - top + 2 * margin;
  // The smallest 3:4 box holding them, but not beyond the photo.
  let boxWidth = Math.ceil(Math.max(needW, (needH * 3) / 4, MIN_CROP_WIDTH));
  let boxHeight = Math.ceil((boxWidth * 4) / 3);
  if (boxWidth > fullWidth || boxHeight > fullHeight) {
    boxWidth = fullWidth;
    boxHeight = fullHeight;
  }
  const place = (lo: number, hi: number, size: number, limit: number) => Math.max(0, Math.min(limit - size, Math.round((lo + hi) / 2 - size / 2)));
  return { left: place(left, right, boxWidth, width), top: place(top, bottom, boxHeight, height), width: boxWidth, height: boxHeight };
}

/**
 * Puts the try-on model's picture back into the photo: inside the (feathered) mask it takes the model's
 * pixels, elsewhere the photo's own, so the face, hands and background keep their full sharpness.
 * `photo` and `result` are RGB of the same size; `feather` is the mask softened (0–255). Changes `photo`.
 */
export function blendTryOn(photo: Uint8Array, result: Uint8Array, feather: Uint8Array): void {
  for (let p = 0; p < feather.length; p += 1) {
    const a = (feather[p] ?? 0) / 255;
    if (a === 0) continue;
    for (let k = 0; k < 3; k += 1) {
      const i = p * 3 + k;
      photo[i] = Math.round((photo[i] ?? 0) * (1 - a) + (result[i] ?? 0) * a);
    }
  }
}
