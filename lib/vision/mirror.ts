import type { GarmentParts, Mask } from "@/lib/garment-photo/segment";

import type { Pose } from "./movenet";

// Fitting a garment picture onto a person in a camera frame, for the live mirror. Pure geometry, so it
// is unit-tested and the browser only draws.
//
// Everything is in the camera's own (unmirrored) coordinates: there, as in a catalogue photo, the
// person's left is on the picture's right. The page mirrors the finished frame for display.
//
// The garment's shoulder line is pinned to the shoulders, its waist to the body's waist (between the
// shoulders and hip joints), and below the waist it hangs towards the knees and partly straight down.
// Its scale follows the shoulders; when the person's outline is known (the camera's person mask), each
// side of each row is fitted to it, so the garment wraps their shape and narrows on the far side when
// they turn. A skirt's hem swings behind the hips as they move (cloth.ts).

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
  /** Height of the shoulder seams (the top edge at the shoulders; a collar stands above it). */
  shoulderY: number;
  waistY: number;
  centreX: number;
  shoulderWidth: number;
  /** Half the width of the garment's body (sleeves left out) on each row, from the centre line; 0 where open. */
  rowHalfWidth?: readonly number[];
  /** How far the top edge drops from beside the neck to the shoulder points (garment pixels). */
  shoulderDrop?: number;
};

export function garmentFit(parts: GarmentParts): GarmentFit {
  const { garment } = parts;
  const box = maskBounds(garment);
  const shoulderWidth = Math.max(1, parts.shoulderWidth);
  const shoulderY = seamHeight(garment, parts.shoulderY, parts.centreX, shoulderWidth);
  return {
    width: garment.width,
    height: garment.height,
    ...box,
    shoulderY,
    waistY: Math.max(parts.waistY, shoulderY + 1),
    centreX: parts.centreX,
    shoulderWidth,
    rowHalfWidth: rowHalfWidths(garment, parts.sleeves, parts.centreX),
    shoulderDrop: shoulderDropOf(garment, parts.centreX, shoulderWidth),
  };
}

/** The top edge's drop between a third and 55% of the shoulder width out from the centre, both sides averaged. */
function shoulderDropOf(garment: Mask, centreX: number, shoulderWidth: number): number {
  const topAt = (x: number) => {
    const column = Math.round(x);
    if (column < 0 || column >= garment.width) return null;
    for (let y = 0; y < garment.height; y += 1) if (garment.data[y * garment.width + column]) return y;
    return null;
  };
  const drops: number[] = [];
  for (const side of [-1, 1]) {
    const inner = topAt(centreX + side * shoulderWidth * 0.33);
    const outer = topAt(centreX + side * shoulderWidth * 0.55);
    if (inner !== null && outer !== null) drops.push(outer - inner);
  }
  const drop = drops.length > 0 ? drops.reduce((a, b) => a + b, 0) / drops.length : 0;
  return Math.min(shoulderWidth * 0.2, Math.max(0, drop));
}

function rowHalfWidths(garment: Mask, sleeves: Mask, centreX: number): number[] {
  const body = (x: number, y: number) => x >= 0 && x < garment.width && !!garment.data[y * garment.width + x] && !sleeves.data[y * garment.width + x];
  const cx = Math.round(centreX);
  return Array.from({ length: garment.height }, (_, y) => {
    if (!body(cx, y)) return 0;
    let left = cx;
    let right = cx;
    while (body(left - 1, y)) left -= 1;
    while (body(right + 1, y)) right += 1;
    return (right - left) / 2;
  });
}

/**
 * Where the shoulder seams are. When the garment's top is a collar standing up around the neck (its top
 * rows are only near the centre line), the seams are the top edge a little inside each shoulder point,
 * and the collar stands above them. Otherwise (no collar, straps, a neckline) the top row is the
 * shoulder line.
 */
function seamHeight(garment: Mask, topY: number, centreX: number, shoulderWidth: number): number {
  const probe = Math.min(garment.height - 1, topY + 2);
  for (let x = 0; x < garment.width; x += 1) {
    if (garment.data[probe * garment.width + x] && Math.abs(x - centreX) > shoulderWidth * 0.3) return topY;
  }
  const reach = Math.round(shoulderWidth * 0.3);
  const heights: number[] = [];
  for (const side of [-1, 1]) {
    const x = Math.round(centreX + side * shoulderWidth * 0.45);
    if (x < 0 || x >= garment.width) continue;
    for (let y = topY; y <= Math.min(garment.height - 1, topY + reach); y += 1) {
      if (garment.data[y * garment.width + x]) {
        heights.push(y);
        break;
      }
    }
  }
  return heights.length > 0 ? Math.round(heights.reduce((a, b) => a + b, 0) / heights.length) : topY;
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
  /** The nose and eyes, when seen: the person's skin colour is read there. */
  face?: { nose: Point; leftEye: Point; rightEye: Point } | null;
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
    face: seen("nose") && seen("leftEye") && seen("rightEye") ? { nose: pose.nose, leftEye: pose.leftEye, rightEye: pose.rightEye } : null,
  };
}

/** Garment shoulder width (seam to seam) ÷ the distance between the shoulder joints. */
export const SEAM_PER_JOINTS = 1.1;
/** The garment's top edge sits this share of the shoulder-joint distance above the joints. */
export const SHOULDER_LIFT = 0.14;
/** The natural waist, as a share of the way from the shoulders down to the hip joints. */
export const BODY_WAIST = 0.6;
/** An arm's width, as a share of the shoulder-joint distance (arms are redrawn this wide over the garment). */
export const ARM_WIDTH = 0.21;
/**
 * Share of a garment's shoulder slope taken out: mannequins' shoulders slope far more than people's, so
 * the outer shoulders would sit low and show the person's own clothes above them.
 */
export const SHOULDER_SQUARE = 0.55;
/** A garment's body widens at most this much to reach arms hanging beside it. */
export const MAX_WIDEN = 1.4;

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

/**
 * How the garment's body is placed on this person, shared by the mapping and the outline measurement:
 * the centre line from the top of the shoulders through the waist and (below it) towards the knees, and
 * the sideways direction on each row.
 */
function bodyFrame(fit: GarmentFit, body: BodyAnchors) {
  // The pose model's shoulder points are the joints; the top of the shoulders (where a garment's top
  // edge rests) is a little higher, "up" being from the hips towards the shoulders.
  const joints = mid(body.leftShoulder, body.rightShoulder);
  const hips = mid(body.leftHip, body.rightHip);
  const up = unit(sub(joints, hips));
  const span = length(sub(body.leftShoulder, body.rightShoulder));
  const lift = span * SHOULDER_LIFT;
  const shoulders = { x: joints.x + up.x * lift, y: joints.y + up.y * lift };
  const waist = lerp(shoulders, hips, BODY_WAIST);
  const acrossShoulders = unit(sub(body.leftShoulder, body.rightShoulder));
  const acrossHips = unit(sub(body.leftHip, body.rightHip));
  const scale = torsoScale(fit, body);
  // Down the garment: the body's shoulder-to-waist distance, kept within reason of the width scale (a
  // garment shouldn't stretch like rubber when the camera sees the torso at an angle).
  const rawDown = length(sub(waist, shoulders)) / (fit.waistY - fit.shoulderY);
  const down = Math.min(Math.max(rawDown, scale * 0.6), scale * 1.6);
  // Below the waist cloth follows the legs, and partly hangs straight down (gravity) when the body leans.
  const legs = unit(sub(body.knees ?? hips, body.knees ? hips : shoulders));
  const below = unit(lerp(legs, { x: 0, y: 1 }, GRAVITY));
  // The garment row level with the hip joints, to blend the sideways direction from shoulders to hips.
  const hipRow = fit.waistY + length(sub(hips, waist)) / down;
  return {
    joints,
    hips,
    span,
    scale,
    hipRow,
    /** The centre line's point on garment row `gy`. */
    axisAt: (gy: number): Point =>
      gy <= fit.waistY
        ? lerp(shoulders, waist, (gy - fit.shoulderY) / (fit.waistY - fit.shoulderY))
        : { x: waist.x + below.x * (gy - fit.waistY) * down, y: waist.y + below.y * (gy - fit.waistY) * down },
    /** Towards the person's left on garment row `gy`. */
    acrossAt: (gy: number): Point => unit(lerp(acrossShoulders, acrossHips, Math.min(1, Math.max(0, (gy - fit.shoulderY) / Math.max(1, hipRow - fit.shoulderY))))),
  };
}

/**
 * The person's outline beside the garment's centre line, measured on the camera's person mask: on each
 * of `rows` (garment rows), how far the body reaches on the person's left and right (camera pixels,
 * along the row; 0 where it wasn't found). Arms are left out: above the hips the body ends where the
 * mask does or where an arm begins; below them, at the furthest leg (hands left out), so a skirt covers
 * legs that step apart.
 */
export type BodyOutline = { rows: number[]; left: number[]; right: number[] };

export function measureOutline(fit: GarmentFit, body: BodyAnchors, person: (x: number, y: number) => number, count = 24): BodyOutline {
  const frame = bodyFrame(fit, body);
  const step = Math.max(1, frame.span / 60);
  const limit = frame.span * 1.6;
  const arms = (["left", "right"] as const).map((side) => armChain(body, side));
  const nearArm = (p: Point, reach: number) => arms.some((chain) => chain.some((a, i) => i > 0 && distanceToSegment(p, chain[i - 1] ?? a, a) < reach));
  const rows = Array.from({ length: count + 1 }, (_, i) => fit.shoulderY + ((fit.bottom - fit.shoulderY) * i) / count);
  const outline: BodyOutline = { rows, left: [], right: [] };
  for (const gy of rows) {
    const axis = frame.axisAt(gy);
    const across = frame.acrossAt(gy);
    const legs = gy > frame.hipRow;
    for (const side of ["left", "right"] as const) {
      const sign = side === "left" ? 1 : -1;
      const at = (d: number): Point => ({ x: axis.x + across.x * d * sign, y: axis.y + across.y * d * sign });
      let reach = 0;
      if (legs) {
        for (let d = 0; d <= limit; d += step) if (person(at(d).x, at(d).y) >= 0.5 && !nearArm(at(d), frame.span * ARM_WIDTH * 0.8)) reach = d;
      } else if (person(axis.x, axis.y) >= 0.5) {
        let d = 0;
        while (d + step <= limit && person(at(d + step).x, at(d + step).y) >= 0.5 && !nearArm(at(d + step), frame.span * ARM_WIDTH * 0.5)) d += step;
        reach = d;
      }
      outline[side].push(reach);
    }
  }
  return outline;
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const ab = sub(b, a);
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / Math.max(1e-9, ab.x * ab.x + ab.y * ab.y)));
  return length(sub(p, lerp(a, b, t)));
}

/** How much wider (or narrower) the garment is drawn on each side, on the outline's rows. */
export type BodyWidths = { rows: number[]; left: number[]; right: number[] };

/** Cloth stands this far off the body (a share of the body's half-width): a garment never looks painted on. */
export const EASE = 1.06;
/** A garment fitted to the body is narrowed at most to this share of its own width (it's made to measure). */
export const MIN_FIT = 0.85;

/**
 * The garment's widths fitted to the person's outline: above the hips it follows the body (wider or
 * narrower, within MIN_FIT…MAX_WIDEN, with EASE), so it wraps their shape, and narrows on the far side
 * when they turn; below the hips it only ever widens, to cover legs that step apart. At the shoulders it
 * keeps its own width (the seams are already placed), taking the body's over the upper chest. Rows the
 * outline missed take their neighbours' widths.
 */
export function fitToOutline(fit: GarmentFit, body: BodyAnchors, outline: BodyOutline): BodyWidths {
  const frame = bodyFrame(fit, body);
  const torso = fit.waistY - fit.shoulderY;
  const widths: BodyWidths = { rows: outline.rows, left: [], right: [] };
  for (const side of ["left", "right"] as const) {
    const raw = outline.rows.map((gy, i) => {
      const natural = naturalHalfWidth(fit, gy) * frame.scale;
      const reach = outline[side][i] ?? 0;
      if (natural <= 0 || reach <= 0) return null;
      const legs = gy > frame.hipRow;
      const wanted = legs ? (reach + frame.span * 0.05) / natural : (reach * EASE) / natural;
      return legs ? Math.min(MAX_WIDEN + 0.2, Math.max(1, wanted)) : Math.min(MAX_WIDEN, Math.max(MIN_FIT, wanted));
    });
    widths[side] = fillGaps(raw)
      .map((v, i, all) => ((all[i - 1] ?? v) + v * 2 + (all[i + 1] ?? v)) / 4)
      .map((factor, i) => {
        const k = Math.min(1, Math.max(0, ((outline.rows[i] ?? 0) - fit.shoulderY) / (torso * 0.3)));
        return 1 + (factor - 1) * k * k * (3 - 2 * k);
      });
  }
  return widths;
}

/** The garment body's half-width on a row, or the nearest row's within a few rows where it's open (a neckline). */
function naturalHalfWidth(fit: GarmentFit, gy: number): number {
  const widths = fit.rowHalfWidth;
  if (!widths) return 0;
  const row = Math.round(gy);
  for (let d = 0; d < 12; d += 1) {
    const w = Math.max(widths[row + d] ?? 0, widths[row - d] ?? 0);
    if (w > 0) return w;
  }
  return 0;
}

function fillGaps(values: (number | null)[]): number[] {
  const known = values.flatMap((v, i) => (v === null ? [] : [i]));
  return values.map((v, i) => {
    if (v !== null) return v;
    const before = [...known].reverse().find((k) => k < i);
    const after = known.find((k) => k > i);
    const a = before === undefined ? null : values[before];
    const b = after === undefined ? null : values[after];
    if (a == null && b == null) return 1;
    if (a == null) return b ?? 1;
    if (b == null || before === undefined || after === undefined) return a;
    return a + ((b - a) * (i - before)) / (after - before);
  });
}

function widthAt(widths: BodyWidths, side: Side, gy: number): number {
  const values = widths[side];
  const { rows } = widths;
  if (rows.length === 0) return 1;
  if (gy <= (rows[0] ?? 0)) return values[0] ?? 1;
  for (let i = 1; i < rows.length; i += 1) {
    const r1 = rows[i] ?? 0;
    if (gy <= r1) {
      const r0 = rows[i - 1] ?? 0;
      const t = (gy - r0) / Math.max(1e-6, r1 - r0);
      return (values[i - 1] ?? 1) + ((values[i] ?? 1) - (values[i - 1] ?? 1)) * t;
    }
  }
  return values[values.length - 1] ?? 1;
}

/** Share of "straight down" in the direction a skirt hangs (the rest follows the legs). */
export const GRAVITY = 0.35;

/**
 * What the person's movement does to the garment, frame by frame: `widths` fits it to their outline
 * (fitToOutline); `sway` is how far the hem trails behind the hips (camera pixels, ClothSway), fading to
 * nothing at the hips.
 */
export type Drape = { widths?: BodyWidths | null; sway?: Point | null };

/** Maps a point of the garment picture to the camera frame, for this body. */
export function garmentToBody(fit: GarmentFit, body: BodyAnchors, drape: Drape = {}): (gx: number, gy: number) => Point {
  const frame = bodyFrame(fit, body);
  const { joints, hips, span, scale, hipRow } = frame;
  const downward = unit(sub(hips, joints));
  const depth = (p: Point) => (p.x - joints.x) * downward.x + (p.y - joints.y) * downward.y;
  /**
   * How much wider the garment's body should be on this side at this point, to reach under an arm
   * hanging beside it (to the arm's centre line; the arm is drawn back over it): the person's own
   * clothes would show in the gap otherwise. Only for arms the camera sees, never more than MAX_WIDEN,
   * and easing back to none below the hand. Used when the person's outline isn't known.
   */
  const widen = (side: Side, axis: Point, across: Point, gy: number): number => {
    const natural = (fit.rowHalfWidth?.[Math.round(gy)] ?? 0) * scale;
    const arm = body.arms[side];
    if (natural <= 0 || gy <= fit.shoulderY || !arm.elbow) return 1;
    const chain = [side === "left" ? body.leftShoulder : body.rightShoulder, arm.elbow, ...(arm.wrist ? [arm.wrist] : [])];
    const target = depth(axis);
    const last = chain[chain.length - 1] ?? arm.elbow;
    let point: Point | null = null;
    for (let i = 0; i + 1 < chain.length && !point; i += 1) {
      const a = chain[i] ?? last;
      const b = chain[i + 1] ?? last;
      const [da, db] = [depth(a), depth(b)];
      if (target >= Math.min(da, db) && target <= Math.max(da, db) && Math.abs(db - da) > 1e-6) point = lerp(a, b, (target - da) / (db - da));
    }
    const beyond = target - depth(last);
    const fade = point ? 1 : beyond > 0 ? Math.max(0, 1 - beyond / (span * 0.15)) : 0;
    const at = point ?? last;
    const inner = ((at.x - axis.x) * across.x + (at.y - axis.y) * across.y) * (side === "left" ? 1 : -1);
    if (fade <= 0 || inner <= natural || inner > natural * MAX_WIDEN) return 1;
    return 1 + (inner / natural - 1) * fade;
  };

  /** Rows to raise this point by: most of the shoulder slope at the shoulders, fading out down the chest. */
  const raise = (gx: number, gy: number): number => {
    const drop = fit.shoulderDrop ?? 0;
    if (drop <= 0) return 0;
    // Rising from beside the neck to the shoulder point, then easing off over the top of the sleeve, so
    // the shoulder stays rounded.
    const out = (Math.abs(gx - fit.centreX) / fit.shoulderWidth - 0.33) / 0.17;
    const across = Math.max(0, out <= 1 ? Math.min(1, out) : 1 - (out - 1) * 0.85);
    const below = Math.min(1, Math.max(0, 1 - (gy - (fit.shoulderY + drop)) / ((fit.waistY - fit.shoulderY) * 0.45)));
    return drop * SHOULDER_SQUARE * across * below;
  };

  const sway = drape.sway;
  const hemRows = fit.bottom - hipRow;
  return (gx, rawGy) => {
    const gy = rawGy - raise(gx, rawGy);
    const axis = frame.axisAt(gy);
    const across = frame.acrossAt(gy);
    // The person's left is towards `across` (from their right shoulder to their left).
    const side: Side = gx >= fit.centreX ? "left" : "right";
    const width = drape.widths ? widthAt(drape.widths, side, gy) : widen(side, axis, across, gy);
    const offset = (gx - fit.centreX) * scale * width;
    const point = { x: axis.x + across.x * offset, y: axis.y + across.y * offset };
    if (!sway || gy <= hipRow || hemRows <= 0) return point;
    // The skirt swings from the hips: not at all there, most at the hem.
    const k = Math.min(1, (gy - hipRow) / hemRows) ** 1.5;
    return { x: point.x + sway.x * k, y: point.y + sway.y * k };
  };
}

export type Triangle = { src: [Point, Point, Point]; dst: [Point, Point, Point] };

/** The garment's bounding box cut into a cols×rows grid of triangle pairs, each mapped onto the body. */
export function garmentMesh(fit: GarmentFit, body: BodyAnchors, cols = 8, rows = 24, drape: Drape = {}): Triangle[] {
  const map = garmentToBody(fit, body, drape);
  // Columns meet at the centre line: each side is fitted on its own, so a triangle mustn't straddle it.
  const half = Math.max(1, Math.round(cols / 2));
  const centre = Math.min(fit.right, Math.max(fit.left + 1, fit.centreX));
  const xs = [
    ...Array.from({ length: half }, (_, i) => fit.left + ((centre - fit.left) * i) / half),
    ...Array.from({ length: cols - half + 1 }, (_, i) => centre + ((fit.right + 1 - centre) * i) / (cols - half)),
  ];
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

/**
 * Whether a sleeve-mask pixel at column `x` belongs to the sleeve on `side`, not the torso. `overlap`
 * pixels further in also count, so a sleeve picture can overlap the body's a little where they join.
 */
export function inSleeve(x: number, side: Side, fit: GarmentFit, overlap = 0): boolean {
  const offset = (x - fit.centreX) * (side === "left" ? 1 : -1);
  return offset > fit.shoulderWidth * SLEEVE_TRUNK - overlap;
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
 * The sleeve mask with what the garment finder missed of the sleeves: it can stop a long sleeve at the
 * elbow (a panjabi's forearms and cuffs). Left in the body, the rest would be drawn as floating pieces
 * instead of following the arms. Added: parts of the body that aren't joined to the torso and lie beside
 * it, and fabric continuing straight down from a sleeve outside the chest's width (a cuff touching the
 * body), until the fabric ends.
 */
export function withLooseSleeves(garment: Mask, sleeves: Mask, fit: GarmentFit): Mask {
  const { width, height } = garment;
  const body = (p: number) => !!garment.data[p] && !sleeves.data[p];
  const label = new Int32Array(width * height).fill(-1);
  const components: { pixels: number[]; sumX: number }[] = [];
  for (let start = 0; start < width * height; start += 1) {
    if (label[start] !== -1 || !body(start)) continue;
    const id = components.length;
    const component = { pixels: [] as number[], sumX: 0 };
    const stack = [start];
    label[start] = id;
    while (stack.length > 0) {
      const p = stack.pop() ?? 0;
      component.pixels.push(p);
      component.sumX += p % width;
      const x = p % width;
      for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width]) {
        if (q >= 0 && q < width * height && label[q] === -1 && body(q)) {
          label[q] = id;
          stack.push(q);
        }
      }
    }
    components.push(component);
  }
  const torso = components.reduce<(typeof components)[number] | null>((best, c) => (!best || c.pixels.length > best.pixels.length ? c : best), null);
  const out = { data: Uint8Array.from(sleeves.data), width, height };
  for (const component of components) {
    if (component === torso) continue;
    const centre = component.sumX / component.pixels.length;
    if (Math.abs(centre - fit.centreX) > fit.shoulderWidth * SLEEVE_TRUNK) for (const p of component.pixels) out.data[p] = 1;
  }
  // The torso's half-width (the body without sleeves) from the chest to below the waist; rows where the
  // centre line is open (a neckline, a pale placket) don't count.
  const torsoRows = fit.waistY - fit.shoulderY;
  const chest = (fit.rowHalfWidth ?? []).slice(Math.round(fit.shoulderY + torsoRows * 0.2), Math.round(fit.waistY + torsoRows) + 1).filter((w) => w > 0);
  const chestHalf = chest.length > 0 ? ([...chest].sort((a, b) => a - b)[Math.floor(chest.length / 2)] ?? 0) : 0;
  if (chestHalf > 0) {
    // The torso on each row: the run of body fabric through the centre line (none where it's open).
    const cx = Math.round(fit.centreX);
    const isBody = (x: number, y: number) => x >= 0 && x < width && !!garment.data[y * width + x] && !out.data[y * width + x];
    const torsoRun = Array.from({ length: height }, (_, y) => {
      if (!isBody(cx, y)) return null;
      let from = cx;
      let to = cx;
      while (isBody(from - 1, y)) from -= 1;
      while (isBody(to + 1, y)) to += 1;
      return { from, to };
    });
    /** Fabric on this row that a gap separates from the torso (a sleeve hanging beside it, not its side). */
    const apart = (x: number, y: number) => {
      const run = torsoRun[y];
      return !!run && (x < run.from || x > run.to);
    };
    for (const side of [-1, 1]) {
      // Each column outside the chest continues down from the sleeve while there's fabric, taking what's
      // apart from the torso; then all stop where the cuff ends at the sleeve's outer edge.
      const runs: { x: number; from: number; to: number; out: number }[] = [];
      for (let x = 0; x < width; x += 1) {
        const outward = (x - fit.centreX) * side;
        if (outward <= chestHalf * 1.05 + 2) continue;
        let y = height - 1;
        while (y >= 0 && !out.data[y * width + x]) y -= 1;
        if (y < 0) continue;
        let to = y + 1;
        while (to < height && garment.data[to * width + x] && !out.data[to * width + x]) to += 1;
        if (to > y + 1) runs.push({ x, from: y + 1, to, out: outward });
      }
      if (runs.length === 0) continue;
      const outer = [...runs].sort((a, b) => b.out - a.out).slice(0, Math.max(1, Math.ceil(runs.length / 3)));
      const cuffEnd = Math.max(...outer.map((r) => r.to));
      for (const run of runs) for (let y = run.from; y < Math.min(run.to, cuffEnd); y += 1) if (apart(run.x, y)) out.data[y * width + run.x] = 1;
    }
  }
  return out;
}

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

/** Share of a sleeve's length over which it turns from the body's shape to the arm's direction. */
export const SLEEVE_BLEND = 0.25;

/**
 * A sleeve bent along the arm: the sleeve's axis (root → end) follows the arm, and its width stays
 * across the arm. At the shoulder it is mapped exactly like the body, so the shoulder cap carries on
 * the body's shoulder line without a step or gap; it turns to follow the arm over SLEEVE_BLEND of its
 * length, as cloth does.
 */
export function sleeveMesh(fit: GarmentFit, sleeve: SleeveFit, body: BodyAnchors, along3 = 3, rows = 10, drape: Drape = {}): Triangle[] {
  const map = garmentToBody(fit, body, drape);
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
  // The mesh reaches well past the sleeve's axis box: its picture is transparent outside the sleeve, and
  // a shoulder cap sticking out of the box would otherwise not be drawn (a hole at the shoulder).
  // Rows every 14% of the sleeve from 28% above its root (so the root itself is on the grid).
  const ts = Array.from({ length: rows + 1 }, (_, j) => -0.28 * sleeve.length + (1.4 * sleeve.length * j) / rows);
  const ss = Array.from({ length: along3 + 1 }, (_, i) => -1.3 * sleeve.halfWidth + (2.6 * sleeve.halfWidth * i) / along3);
  const src = (t: number, s: number): Point => ({ x: sleeve.root.x + axis.x * t + perp.x * s, y: sleeve.root.y + axis.y * t + perp.y * s });
  const onArm = (t: number, s: number): Point => {
    const { point, direction } = along(chain, t * lengthwise);
    const across = { x: -direction.y, y: direction.x };
    return { x: point.x + across.x * s * scale, y: point.y + across.y * s * scale };
  };
  const dst = (t: number, s: number): Point => {
    const k = Math.min(1, Math.max(0, t / (sleeve.length * SLEEVE_BLEND)));
    const w = k * k * (3 - 2 * k);
    const p = src(t, s);
    return lerp(map(p.x, p.y), onArm(t, s), w);
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
