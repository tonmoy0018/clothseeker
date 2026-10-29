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
};

/** Shoulders and hips are needed to place a garment; knees help it hang the right way. */
export function bodyAnchors(pose: Pose, minScore = 0.3): BodyAnchors | null {
  const seen = (k: keyof Pose) => pose[k].score >= minScore;
  if (!seen("leftShoulder") || !seen("rightShoulder") || !seen("leftHip") || !seen("rightHip")) return null;
  // Facing away (left shoulder on the picture's left), the garment's front can't be shown.
  if (pose.leftShoulder.x <= pose.rightShoulder.x) return null;
  const knees = seen("leftKnee") && seen("rightKnee") ? mid(pose.leftKnee, pose.rightKnee) : null;
  return { leftShoulder: pose.leftShoulder, rightShoulder: pose.rightShoulder, leftHip: pose.leftHip, rightHip: pose.rightHip, knees };
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
  const scale = (length(sub(body.leftShoulder, body.rightShoulder)) * SEAM_PER_JOINTS) / fit.shoulderWidth;
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
