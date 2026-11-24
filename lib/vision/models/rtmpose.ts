import { KEYPOINT_NAMES, type Keypoint, type Pose } from "./movenet";
import type { PersonMask } from "./segment";

// RTMPose-s (OpenMMLab, body7 weights, Apache-2.0): the live mirror's body model. Same 17 COCO keypoints
// as MoveNet, far more accurate (elbows, hips), at about twice MoveNet Lightning's cost. Top-down: it reads
// one person in a crop around them, so the crop is tracked from frame to frame (`BodyTracker`).
// Input: float32 [1, 3, 256, 192] RGB, normalised with ImageNet mean/std. Outputs: `simcc_x`
// [1, 17, 384] and `simcc_y` [1, 17, 512], per-keypoint scores along each axis at half-pixel steps.

export const RTMPOSE_WIDTH = 192;
export const RTMPOSE_HEIGHT = 256;
/** SimCC bins per input pixel. */
const SPLIT = 2;
/** The crop is the person's box grown this much (as RTMPose was trained). */
const PADDING = 1.25;

const MEAN = [123.675, 116.28, 103.53] as const;
const STD = [58.395, 57.12, 57.375] as const;

/** A box in source pixels. */
export type Box = { x: number; y: number; width: number; height: number };

/** A person box → the model's crop: centred on it, grown by PADDING, in the model's 3:4 shape. */
export function cropFor(person: Box): Box {
  let width = person.width * PADDING;
  let height = person.height * PADDING;
  if (width / height > RTMPOSE_WIDTH / RTMPOSE_HEIGHT) height = (width * RTMPOSE_HEIGHT) / RTMPOSE_WIDTH;
  else width = (height * RTMPOSE_WIDTH) / RTMPOSE_HEIGHT;
  return { x: person.x + person.width / 2 - width / 2, y: person.y + person.height / 2 - height / 2, width, height };
}

/** RGBA pixels of the 192×256 crop → the model's planar, normalised RGB input. */
export function rtmposeInput(rgba: ArrayLike<number>): Float32Array {
  const plane = RTMPOSE_WIDTH * RTMPOSE_HEIGHT;
  const out = new Float32Array(plane * 3);
  for (let p = 0; p < plane; p += 1) {
    for (let c = 0; c < 3; c += 1) out[c * plane + p] = ((rgba[p * 4 + c] ?? 0) - (MEAN[c] ?? 0)) / (STD[c] ?? 1);
  }
  return out;
}

/**
 * The strongest bin of keypoint k's row (to a fraction of a bin: a parabola through it and its neighbours)
 * and its score. Without the fraction, camera noise flips the peak between neighbouring bins and the
 * joint jumps by a whole bin.
 */
function peak(values: ArrayLike<number>, k: number, bins: number): [number, number] {
  let best = 0;
  let score = -Infinity;
  for (let i = 0; i < bins; i += 1) {
    const v = values[k * bins + i] ?? -Infinity;
    if (v > score) {
      score = v;
      best = i;
    }
  }
  if (best === 0 || best === bins - 1) return [best, score];
  const left = values[k * bins + best - 1] ?? score;
  const right = values[k * bins + best + 1] ?? score;
  const curve = left - 2 * score + right;
  return [curve < 0 ? best + Math.max(-0.5, Math.min(0.5, (left - right) / (2 * curve))) : best, score];
}

/** The model's outputs and the crop they were read in → keypoints in source pixels, scores 0–1. */
export function decodeRtmpose(simccX: ArrayLike<number>, simccY: ArrayLike<number>, crop: Box): Pose {
  const binsX = RTMPOSE_WIDTH * SPLIT;
  const binsY = RTMPOSE_HEIGHT * SPLIT;
  const at = (k: number): Keypoint => {
    const [bx, sx] = peak(simccX, k, binsX);
    const [by, sy] = peak(simccY, k, binsY);
    // The weaker axis decides (as in mmpose), clamped: the raw values can pass 1.
    const score = Math.min(1, Math.max(0, Math.min(sx, sy)));
    return { x: crop.x + (bx / binsX) * crop.width, y: crop.y + (by / binsY) * crop.height, score };
  };
  return {
    nose: at(0),
    leftEye: at(1),
    rightEye: at(2),
    leftEar: at(3),
    rightEar: at(4),
    leftShoulder: at(5),
    rightShoulder: at(6),
    leftElbow: at(7),
    rightElbow: at(8),
    leftWrist: at(9),
    rightWrist: at(10),
    leftHip: at(11),
    rightHip: at(12),
    leftKnee: at(13),
    rightKnee: at(14),
    leftAnkle: at(15),
    rightAnkle: at(16),
  };
}

/** Keypoints this sure count when tracking the person's box. */
const TRACK_SCORE = 0.3;

/**
 * Where the person is, from the last pose: the box around its sure keypoints, grown for the head above
 * the eyes and for movement until the next frame. Null when the pose is lost (no shoulders, too few points).
 */
export function poseBox(pose: Pose): Box | null {
  const sure = KEYPOINT_NAMES.map((name) => pose[name]).filter((p) => p.score >= TRACK_SCORE);
  if (sure.length < 5 || pose.leftShoulder.score < TRACK_SCORE || pose.rightShoulder.score < TRACK_SCORE) return null;
  const xs = sure.map((p) => p.x);
  const ys = sure.map((p) => p.y);
  const x1 = Math.min(...xs);
  const x2 = Math.max(...xs);
  const y1 = Math.min(...ys);
  const y2 = Math.max(...ys);
  const shoulders = Math.hypot(pose.leftShoulder.x - pose.rightShoulder.x, pose.leftShoulder.y - pose.rightShoulder.y);
  // A shoulder width around everything covers the top of the head and hands that moved since.
  const grow = Math.max(shoulders * 0.6, (x2 - x1) * 0.1, (y2 - y1) * 0.1);
  return { x: x1 - grow, y: y1 - grow, width: x2 - x1 + 2 * grow, height: y2 - y1 + 2 * grow };
}

/** The box around both (either may be missing). */
export function unionBox(a: Box | null, b: Box | null): Box | null {
  if (!a || !b) return a ?? b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/**
 * How far (a share of the crop) the crop the person needs may move, or change size (×1.5), before the crop
 * follows it. A crop that moves with every frame's jitter makes the model's answers jitter too.
 */
export const CROP_HOLD = 0.06;

/**
 * Where the body model looks, frame by frame: around the person's last pose, widened to their outline
 * (legs coming into view as they step back), else the last outline, else the whole frame. The same
 * box every frame (the latest outline, not only on the frames the outline model runs), and it stays put
 * while the person stays inside it. Lets go when the shoulders are lost; another frame size starts afresh.
 */
export class BodyTracker {
  private pose: Box | null = null;
  private outline: Box | null = null;
  private crop: Box | null = null;
  private size = "";

  /** The crop for this frame; `outline` is this frame's outline box when the outline model ran. */
  next(width: number, height: number, outline: Box | null): Box {
    if (this.size !== `${width}x${height}`) {
      this.size = `${width}x${height}`;
      this.pose = null;
      this.outline = null;
      this.crop = null;
    }
    if (outline) this.outline = outline;
    const wanted = cropFor(unionBox(this.pose, this.outline) ?? { x: 0, y: 0, width, height });
    const held = this.crop;
    if (
      held &&
      Math.abs(wanted.x + wanted.width / 2 - (held.x + held.width / 2)) < held.width * CROP_HOLD &&
      Math.abs(wanted.y + wanted.height / 2 - (held.y + held.height / 2)) < held.height * CROP_HOLD &&
      Math.abs(Math.log(wanted.width / held.width)) < CROP_HOLD * 1.5
    ) {
      return held;
    }
    this.crop = wanted;
    return wanted;
  }

  /** The pose found in this frame's crop. */
  found(pose: Pose): void {
    this.pose = poseBox(pose);
  }
}

/** Where the person is, from the outline: the box around its sure pixels, in source pixels. Null if none. */
export function maskBox(mask: PersonMask): Box | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if ((mask.alpha[y * mask.width + x] ?? 0) < 0.5) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x + 1);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y + 1);
    }
  }
  if (maxX <= minX || maxY <= minY) return null;
  const { scale, offsetX, offsetY } = mask.box;
  return { x: (minX - offsetX) / scale, y: (minY - offsetY) / scale, width: (maxX - minX) / scale, height: (maxY - minY) / scale };
}
