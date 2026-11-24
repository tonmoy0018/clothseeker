import { toSource, type FitBox } from "./geometry";

// MoveNet SinglePose Lightning (Xenova/movenet-singlepose-lightning, Apache-2.0): one person's 17 COCO
// keypoints. Input: int32 [1, 192, 192, 3] RGB 0–255. Output: float32 [1, 1, 17, 3] as (y, x, score),
// y and x as fractions of the input square. "Left" and "right" are the person's own sides.

export const MOVENET_SIZE = 192;

export const KEYPOINT_NAMES = [
  "nose",
  "leftEye",
  "rightEye",
  "leftEar",
  "rightEar",
  "leftShoulder",
  "rightShoulder",
  "leftElbow",
  "rightElbow",
  "leftWrist",
  "rightWrist",
  "leftHip",
  "rightHip",
  "leftKnee",
  "rightKnee",
  "leftAnkle",
  "rightAnkle",
] as const;
export type KeypointName = (typeof KEYPOINT_NAMES)[number];

/** A keypoint in source pixels, with the model's confidence (0–1). */
export type Keypoint = { x: number; y: number; score: number };
export type Pose = Record<KeypointName, Keypoint>;

/** RGBA pixels of the 192×192 letterboxed frame → the model's int32 RGB input. */
export function movenetInput(rgba: ArrayLike<number>): Int32Array {
  const pixels = MOVENET_SIZE * MOVENET_SIZE;
  const out = new Int32Array(pixels * 3);
  for (let p = 0; p < pixels; p += 1) {
    out[p * 3] = rgba[p * 4] ?? 0;
    out[p * 3 + 1] = rgba[p * 4 + 1] ?? 0;
    out[p * 3 + 2] = rgba[p * 4 + 2] ?? 0;
  }
  return out;
}

export function decodeMovenet(output: ArrayLike<number>, box: FitBox): Pose {
  const at = (i: number): Keypoint => {
    const [x, y] = toSource(box, (output[i * 3 + 1] ?? 0) * box.size, (output[i * 3] ?? 0) * box.size);
    return { x, y, score: output[i * 3 + 2] ?? 0 };
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
