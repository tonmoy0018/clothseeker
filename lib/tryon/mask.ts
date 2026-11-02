import type { GarmentTypeInfo } from "@/lib/catalog/garment-types";
import type { Keypoint, Pose } from "@/lib/vision/movenet";

// The area of a customer's photo a local try-on model repaints (lib/ai/tryon-local.ts): their own
// clothes where the new garment goes, plus room around them, so a dress can be wider than the jeans
// it replaces and sleeves can be drawn or removed. The face, hands, feet and background outside it are
// kept as they are. Built from the on-device body points and person mask; pure, so it's unit-tested.

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
 * The try-on mask: 255 where the model may repaint, 0 where the photo is kept. Null when the shoulders
 * and hips aren't found (the photo check refuses such photos earlier).
 */
export function tryOnMask(pose: Pose, person: PersonAt | null, width: number, height: number, reach: TryOnReach): Uint8Array | null {
  const { leftShoulder: ls, rightShoulder: rs, leftHip: lh, rightHip: rh } = pose;
  if (![ls, rs, lh, rh].every(seen)) return null;
  const shoulders = mid(ls, rs);
  const hips = mid(lh, rh);
  const span = Math.max(1, Math.hypot(ls.x - rs.x, ls.y - rs.y));
  const torso = Math.max(span * 0.5, hips.y - shoulders.y);
  const hipSpan = Math.hypot(lh.x - rh.x, lh.y - rh.y);

  // Top: the lower neck (necklines and collars are redrawn), never the chin.
  const nose = pose.nose;
  const top = seen(nose) ? Math.max(nose.y + (shoulders.y - nose.y) * 0.6, shoulders.y - span * 0.35) : shoulders.y - span * 0.2;

  // Legs: guessed below the picture or from the knees when the model doesn't see them.
  const knees = seen(pose.leftKnee) && seen(pose.rightKnee) ? mid(pose.leftKnee, pose.rightKnee) : { x: hips.x, y: hips.y + torso * 0.9 };
  const ankles = seen(pose.leftAnkle) && seen(pose.rightAnkle) ? mid(pose.leftAnkle, pose.rightAnkle) : { x: knees.x, y: Math.min(height, knees.y + (knees.y - hips.y)) };
  // Dresses: a little past the ankle points, so trouser and legging cuffs are repainted too.
  const hem = reach === "hips" ? hips.y + torso * 0.3 : reach === "knees" ? knees.y + torso * 0.15 : ankles.y + torso * 0.1;
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
  // Hands stay: a disc just past each wrist.
  const hands: P[] = [];
  for (const [elbow, wrist] of [
    [pose.leftElbow, pose.leftWrist],
    [pose.rightElbow, pose.rightWrist],
  ] as const) {
    if (!seen(wrist)) continue;
    const dx = seen(elbow) ? wrist.x - elbow.x : 0;
    const dy = seen(elbow) ? wrist.y - elbow.y : 1;
    const length = Math.max(1e-6, Math.hypot(dx, dy));
    hands.push({ x: wrist.x + (dx / length) * span * 0.22, y: wrist.y + (dy / length) * span * 0.22 });
  }
  const handRadius = span * 0.2;

  const out = new Uint8Array(width * height);
  const bottom = Math.min(height - 1, Math.ceil(hem));
  for (let y = Math.max(0, Math.floor(top)); y <= bottom; y += 1) {
    const c = centre(y);
    const h = half(y);
    for (let x = 0; x < width; x += 1) {
      const p = { x, y };
      if (hands.some((hand) => Math.hypot(x - hand.x, y - hand.y) < handRadius)) continue;
      const inOutline = Math.abs(x - c) <= h;
      const onArm = arms.some(([a, b, r]) => distanceToSegment(p, a, b) <= r);
      // Own clothes sticking out further (a wide skirt, baggy sleeves) are repainted too.
      const ownClothes = person !== null && person(x, y) >= PERSON && Math.abs(x - c) <= h * 1.8;
      if (inOutline || onArm || ownClothes) out[y * width + x] = 255;
    }
  }
  return out;
}

export type Box = { left: number; top: number; width: number; height: number };

/**
 * The largest 3:4 (width:height) box inside the photo that holds the whole mask, centred on it where the
 * photo allows: try-on models work on 3:4 pictures, and the rest of the photo is kept as it is.
 */
export function tryOnCrop(mask: Uint8Array, width: number, height: number): Box {
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  const boxWidth = Math.min(width, Math.floor((height * 3) / 4));
  const boxHeight = Math.min(height, Math.floor((boxWidth * 4) / 3));
  const place = (lo: number, hi: number, size: number, limit: number) => {
    if (hi < lo) return Math.floor((limit - size) / 2);
    return Math.max(0, Math.min(limit - size, Math.round((lo + hi) / 2 - size / 2)));
  };
  return { left: place(minX, maxX, boxWidth, width), top: place(minY, maxY, boxHeight, height), width: boxWidth, height: boxHeight };
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
