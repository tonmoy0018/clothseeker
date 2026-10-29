import type { GarmentParts, Mask } from "@/lib/garment-photo/segment";

import type { Pose } from "./movenet";

// Fitting a garment picture onto a person in a camera frame, for the live mirror. Pure geometry, so it
// is unit-tested and the browser only draws.
//
// Everything is in the camera's own (unmirrored) coordinates: there, as in a catalogue photo, the
// person's left is on the picture's right. The page mirrors the finished frame for display.
//
// The garment's shoulder line is pinned to the shoulders, its waist to the body's waist (between the
// shoulders and hip joints), and below the waist it hangs along the hips→knees direction. Its width
// follows the shoulders, so turning narrows it.

export type Point = { x: number; y: number };

/** Where a garment picture's shoulders, waist and hem are, in its own pixels. */
export type GarmentFit = {
  width: number;
  height: number;
  /** The garment's bounding box (rows and columns with fabric). */
  top: number;
  bottom: number;
  left: number;
  right: number;
  shoulderY: number;
  waistY: number;
  centreX: number;
  shoulderWidth: number;
};

export function garmentFit(parts: GarmentParts): GarmentFit {
  const { garment } = parts;
  const box = maskBounds(garment);
  return {
    width: garment.width,
    height: garment.height,
    ...box,
    shoulderY: parts.shoulderY,
    waistY: Math.max(parts.waistY, parts.shoulderY + 1),
    centreX: parts.centreX,
    shoulderWidth: Math.max(1, parts.shoulderWidth),
  };
}

export function maskBounds(mask: Mask): { top: number; bottom: number; left: number; right: number } {
  let top = mask.height;
  let bottom = -1;
  let left = mask.width;
  let right = -1;
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if (!mask.data[y * mask.width + x]) continue;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  return bottom < 0 ? { top: 0, bottom: mask.height - 1, left: 0, right: mask.width - 1 } : { top, bottom, left, right };
}

export type BodyAnchors = {
  leftShoulder: Point;
  rightShoulder: Point;
  leftHip: Point;
  rightHip: Point;
  /** Midpoint of the knees, when both are seen. */
  knees: Point | null;
  /** Elbows and wrists (the person's own sides), when seen: sleeves and arms follow them. */
  arms: Record<Side, { elbow: Point | null; wrist: Point | null }>;
};

/** The wearer's own side: "left" is on the picture's right (in garment photos and the camera alike). */
export type Side = "left" | "right";

/** Shoulders and hips are needed to place a garment; knees help it hang the right way. */
export function bodyAnchors(pose: Pose, minScore = 0.3): BodyAnchors | null {
  const seen = (k: keyof Pose) => pose[k].score >= minScore;
  if (!seen("leftShoulder") || !seen("rightShoulder") || !seen("leftHip") || !seen("rightHip")) return null;
  // Facing away (left shoulder on the picture's left), the garment's front can't be shown.
  if (pose.leftShoulder.x <= pose.rightShoulder.x) return null;
  const knees = seen("leftKnee") && seen("rightKnee") ? mid(pose.leftKnee, pose.rightKnee) : null;
  const point = (k: keyof Pose): Point | null => (seen(k) ? { x: pose[k].x, y: pose[k].y } : null);
  return {
    leftShoulder: pose.leftShoulder,
    rightShoulder: pose.rightShoulder,
    leftHip: pose.leftHip,
    rightHip: pose.rightHip,
    knees,
    arms: { left: { elbow: point("leftElbow"), wrist: point("leftWrist") }, right: { elbow: point("rightElbow"), wrist: point("rightWrist") } },
  };
}

/** Garment shoulder width (seam to seam) ÷ the distance between the shoulder joints. */
export const SEAM_PER_JOINTS = 1.2;
/** The garment's top edge sits this share of the shoulder-joint distance above the joints. */
export const SHOULDER_LIFT = 0.16;
/** The natural waist, as a share of the way from the shoulders down to the hip joints. */
export const BODY_WAIST = 0.6;

const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const length = (p: Point) => Math.hypot(p.x, p.y);
const unit = (p: Point): Point => {
  const l = length(p);
  return l > 1e-6 ? { x: p.x / l, y: p.y / l } : { x: 1, y: 0 };
};
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** Garment pixels → camera pixels, set by the shoulders. */
export function torsoScale(fit: GarmentFit, body: BodyAnchors): number {
  return (length(sub(body.leftShoulder, body.rightShoulder)) * SEAM_PER_JOINTS) / fit.shoulderWidth;
}

/** Maps a point of the garment picture to the camera frame, for this body. */
export function garmentToBody(fit: GarmentFit, body: BodyAnchors): (gx: number, gy: number) => Point {
  // The pose model's shoulder points are the joints; the top of the shoulders (where a garment's top
  // edge rests) is a little higher, "up" being from the hips towards the shoulders.
  const joints = mid(body.leftShoulder, body.rightShoulder);
  const hips = mid(body.leftHip, body.rightHip);
  const up = unit(sub(joints, hips));
  const lift = length(sub(body.leftShoulder, body.rightShoulder)) * SHOULDER_LIFT;
  const shoulders = { x: joints.x + up.x * lift, y: joints.y + up.y * lift };
  const waist = lerp(shoulders, hips, BODY_WAIST);
  const acrossShoulders = unit(sub(body.leftShoulder, body.rightShoulder));
  const acrossHips = unit(sub(body.leftHip, body.rightHip));
  const scale = torsoScale(fit, body);
  // Down the garment: the body's shoulder-to-waist distance, kept within reason of the width scale (a
  // garment shouldn't stretch like rubber when the camera sees the torso at an angle).
  const rawDown = length(sub(waist, shoulders)) / (fit.waistY - fit.shoulderY);
  const down = Math.min(Math.max(rawDown, scale * 0.6), scale * 1.6);
  const below = unit(sub(body.knees ?? hips, body.knees ? hips : shoulders));
  // The garment row level with the hip joints, to blend the sideways direction from shoulders to hips.
  const hipRow = fit.waistY + length(sub(hips, waist)) / down;

  return (gx, gy) => {
    const axis =
      gy <= fit.waistY
        ? lerp(shoulders, waist, (gy - fit.shoulderY) / (fit.waistY - fit.shoulderY))
        : { x: waist.x + below.x * (gy - fit.waistY) * down, y: waist.y + below.y * (gy - fit.waistY) * down };
    const t = Math.min(1, Math.max(0, (gy - fit.shoulderY) / Math.max(1, hipRow - fit.shoulderY)));
    const across = unit(lerp(acrossShoulders, acrossHips, t));
    const offset = (gx - fit.centreX) * scale;
    return { x: axis.x + across.x * offset, y: axis.y + across.y * offset };
  };
}

export type Triangle = { src: [Point, Point, Point]; dst: [Point, Point, Point] };

/** The garment's bounding box cut into a cols×rows grid of triangle pairs, each mapped onto the body. */
export function garmentMesh(fit: GarmentFit, body: BodyAnchors, cols = 6, rows = 16): Triangle[] {
  const map = garmentToBody(fit, body);
  const xs = Array.from({ length: cols + 1 }, (_, i) => fit.left + ((fit.right + 1 - fit.left) * i) / cols);
  const ys = Array.from({ length: rows + 1 }, (_, j) => fit.top + ((fit.bottom + 1 - fit.top) * j) / rows);
  const triangles: Triangle[] = [];
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      const [x0, x1, y0, y1] = [xs[i] ?? 0, xs[i + 1] ?? 0, ys[j] ?? 0, ys[j + 1] ?? 0];
      const [s0, s1, s2, s3] = [
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
      ];
      const [d0, d1, d2, d3] = [map(x0, y0), map(x1, y0), map(x1, y1), map(x0, y1)];
      triangles.push({ src: [s0, s1, s2], dst: [d0, d1, d2] }, { src: [s0, s2, s3], dst: [d0, d2, d3] });
    }
  }
  return triangles;
}

/**
 * The affine transform (canvas `setTransform` order a, b, c, d, e, f) taking the source triangle onto the
 * destination triangle, or null when the source is degenerate.
 */
export function triangleTransform(src: [Point, Point, Point], dst: [Point, Point, Point]): [number, number, number, number, number, number] | null {
  const [s0, s1, s2] = src;
  const [d0, d1, d2] = dst;
  const det = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
  if (Math.abs(det) < 1e-9) return null;
  const a = ((d1.x - d0.x) * (s2.y - s0.y) - (d2.x - d0.x) * (s1.y - s0.y)) / det;
  const c = ((d2.x - d0.x) * (s1.x - s0.x) - (d1.x - d0.x) * (s2.x - s0.x)) / det;
  const b = ((d1.y - d0.y) * (s2.y - s0.y) - (d2.y - d0.y) * (s1.y - s0.y)) / det;
  const d = ((d2.y - d0.y) * (s1.x - s0.x) - (d1.y - d0.y) * (s2.x - s0.x)) / det;
  const e = d0.x - a * s0.x - c * s0.y;
  const f = d0.y - b * s0.x - d * s0.y;
  return [a, b, c, d, e, f];
}

// ─── sleeves and arms ────────────────────────────────────────────────────────

/**
 * Sleeve-mask pixels closer to the centre than this share of the shoulder width belong to the torso:
 * the mask can reach into the chest (e.g. long sleeves hanging close to a panjabi's body).
 */
export const SLEEVE_TRUNK = 0.42;

/** Whether a sleeve-mask pixel at column `x` belongs to the sleeve on `side`, not the torso. */
export function inSleeve(x: number, side: Side, fit: GarmentFit): boolean {
  const offset = (x - fit.centreX) * (side === "left" ? 1 : -1);
  return offset > fit.shoulderWidth * SLEEVE_TRUNK;
}

/** A sleeve of the garment picture: where it joins the body, where it ends, and how wide it is. */
export type SleeveFit = {
  side: Side;
  root: Point;
  end: Point;
  /** Half the sleeve's width across its axis (garment pixels). */
  halfWidth: number;
  length: number;
};

/**
 * The garment's sleeves, from the sleeve mask (lib/garment-photo/segment.ts). A sleeve must leave the
 * shoulder outwards or downwards and be long enough: straps of sleeveless dresses (also in that mask)
 * aren't sleeves and stay with the body.
 */
export function sleeveFits(sleeves: Mask, fit: GarmentFit): SleeveFit[] {
  const fits: SleeveFit[] = [];
  let sleeveArea = 0;
  for (const v of sleeves.data) if (v) sleeveArea += 1;
  for (const side of ["left", "right"] as const) {
    const outward = side === "left" ? 1 : -1;
    const points: Point[] = [];
    for (let y = 0; y < sleeves.height; y += 1) {
      for (let x = 0; x < sleeves.width; x += 1) {
        if (!sleeves.data[y * sleeves.width + x]) continue;
        if (inSleeve(x, side, fit)) points.push({ x, y });
      }
    }
    if (points.length < 30 || points.length < sleeveArea * 0.2) continue;
    const root = { x: fit.centreX + (outward * fit.shoulderWidth) / 2, y: fit.shoulderY + fit.shoulderWidth * 0.06 };
    const byDistance = points.map((p) => ({ p, d: length(sub(p, root)) })).sort((a, b) => b.d - a.d);
    const far = byDistance.slice(0, Math.max(5, Math.round(byDistance.length * 0.15)));
    const end = { x: far.reduce((s, f) => s + f.p.x, 0) / far.length, y: far.reduce((s, f) => s + f.p.y, 0) / far.length };
    const span = length(sub(end, root));
    const goesOut = (end.x - root.x) * outward > -0.1 * fit.shoulderWidth;
    if (span < fit.shoulderWidth * 0.15 || !goesOut || end.y < root.y - fit.shoulderWidth * 0.2) continue;
    const axis = unit(sub(end, root));
    const perp = { x: -axis.y, y: axis.x };
    const offsets = points.map((p) => Math.abs((p.x - root.x) * perp.x + (p.y - root.y) * perp.y)).sort((a, b) => a - b);
    const halfWidth = (offsets[Math.floor(offsets.length * 0.95)] ?? 0) + 3;
    fits.push({ side, root, end, halfWidth, length: span });
  }
  return fits;
}

/** A point and direction at a distance along a polyline (extended straight past both ends). */
function along(chain: readonly Point[], distance: number): { point: Point; direction: Point } {
  const first = chain[0] ?? { x: 0, y: 0 };
  let remaining = distance;
  for (let i = 0; i + 1 < chain.length; i += 1) {
    const a = chain[i] ?? first;
    const b = chain[i + 1] ?? a;
    const segment = length(sub(b, a));
    const direction = unit(sub(b, a));
    if (remaining <= segment || i + 2 === chain.length || remaining < 0) {
      return { point: { x: a.x + direction.x * remaining, y: a.y + direction.y * remaining }, direction };
    }
    remaining -= segment;
  }
  return { point: first, direction: { x: 0, y: 1 } };
}

/**
 * The arm the person holds out on this side: shoulder joint → elbow → wrist → end of the hand. Unseen
 * joints hang straight down from the one above (along the torso).
 */
export function armChain(body: BodyAnchors, side: Side): Point[] {
  const shoulder = side === "left" ? body.leftShoulder : body.rightShoulder;
  const shoulders = mid(body.leftShoulder, body.rightShoulder);
  const hips = mid(body.leftHip, body.rightHip);
  const down = unit(sub(hips, shoulders));
  const upperArm = length(sub(hips, shoulders)) * 0.62;
  const arm = body.arms[side];
  const elbow = arm.elbow ?? { x: shoulder.x + down.x * upperArm, y: shoulder.y + down.y * upperArm };
  const forearm = unit(sub(arm.wrist ?? { x: elbow.x + down.x, y: elbow.y + down.y }, elbow));
  const wrist = arm.wrist ?? { x: elbow.x + forearm.x * upperArm * 0.9, y: elbow.y + forearm.y * upperArm * 0.9 };
  const hand = { x: wrist.x + forearm.x * upperArm * 0.35, y: wrist.y + forearm.y * upperArm * 0.35 };
  return [{ x: shoulder.x, y: shoulder.y }, elbow, wrist, hand];
}

/**
 * A sleeve bent along the arm: the sleeve's axis (root → end) follows the arm from where the sleeve
 * joins the body (continuous with the torso), and its width stays across the arm.
 */
export function sleeveMesh(fit: GarmentFit, sleeve: SleeveFit, body: BodyAnchors, along3 = 3, rows = 10): Triangle[] {
  const map = garmentToBody(fit, body);
  const scale = torsoScale(fit, body);
  const arm = armChain(body, sleeve.side);
  const shoulder = arm[0] ?? map(sleeve.root.x, sleeve.root.y);
  const rootOnBody = map(sleeve.root.x, sleeve.root.y);
  // The sleeve runs alongside the arm, a little outside the joints at the shoulder, closer lower down.
  const offset = sub(rootOnBody, shoulder);
  const chain = arm.map((p, i) => (i === 0 ? rootOnBody : { x: p.x + offset.x * (i === 1 ? 0.4 : 0.2), y: p.y + offset.y * (i === 1 ? 0.4 : 0.2) }));
  const axis = unit(sub(sleeve.end, sleeve.root));
  const perp = { x: -axis.y, y: axis.x };
  // Along the arm, a sleeve never reaches past the wrist (a mannequin's sleeve can hang longer than the
  // person's arm); across, it keeps the garment's scale.
  const toWrist = length(sub(chain[1] ?? rootOnBody, rootOnBody)) + length(sub(chain[2] ?? rootOnBody, chain[1] ?? rootOnBody));
  const lengthwise = Math.min(scale, (toWrist * 1.02) / sleeve.length);
  const ts = Array.from({ length: rows + 1 }, (_, j) => -0.12 * sleeve.length + (1.22 * sleeve.length * j) / rows);
  const ss = Array.from({ length: along3 + 1 }, (_, i) => -sleeve.halfWidth + (2 * sleeve.halfWidth * i) / along3);
  const src = (t: number, s: number): Point => ({ x: sleeve.root.x + axis.x * t + perp.x * s, y: sleeve.root.y + axis.y * t + perp.y * s });
  const dst = (t: number, s: number): Point => {
    const { point, direction } = along(chain, t * lengthwise);
    const across = { x: -direction.y, y: direction.x };
    return { x: point.x + across.x * s * scale, y: point.y + across.y * s * scale };
  };
  const triangles: Triangle[] = [];
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < along3; i += 1) {
      const [t0, t1, s0, s1] = [ts[j] ?? 0, ts[j + 1] ?? 0, ss[i] ?? 0, ss[i + 1] ?? 0];
      const [a, b, c, d] = [src(t0, s0), src(t0, s1), src(t1, s1), src(t1, s0)];
      const [A, B, C, D] = [dst(t0, s0), dst(t0, s1), dst(t1, s1), dst(t1, s0)];
      triangles.push({ src: [a, b, c], dst: [A, B, C] }, { src: [a, c, d], dst: [A, C, D] });
    }
  }
  return triangles;
}

/**
 * The part of the arm to draw in front of the garment: from where the sleeve ends (or a little below
 * the shoulder for a sleeveless garment) to the end of the hand.
 */
export function exposedArm(fit: GarmentFit, body: BodyAnchors, side: Side, sleeve: SleeveFit | null): Point[] {
  const chain = armChain(body, side);
  const upper = length(sub(chain[1] ?? chain[0] ?? { x: 0, y: 0 }, chain[0] ?? { x: 0, y: 0 }));
  let toWrist = 0;
  for (let i = 0; i < 2; i += 1) toWrist += length(sub(chain[i + 1] ?? { x: 0, y: 0 }, chain[i] ?? { x: 0, y: 0 }));
  const covered = sleeve ? Math.min(sleeve.length * torsoScale(fit, body), toWrist * 1.02) : upper * 0.3;
  let total = 0;
  for (let i = 0; i + 1 < chain.length; i += 1) total += length(sub(chain[i + 1] ?? { x: 0, y: 0 }, chain[i] ?? { x: 0, y: 0 }));
  if (covered >= total - 1) return [];
  const points = [along(chain, covered).point];
  let walked = 0;
  for (let i = 0; i + 1 < chain.length; i += 1) {
    walked += length(sub(chain[i + 1] ?? { x: 0, y: 0 }, chain[i] ?? { x: 0, y: 0 }));
    if (walked > covered) points.push(chain[i + 1] ?? { x: 0, y: 0 });
  }
  return points;
}
