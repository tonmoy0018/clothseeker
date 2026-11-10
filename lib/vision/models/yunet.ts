import { toSource, type FitBox } from "./geometry";

// YuNet face detector (opencv/face_detection_yunet, 2023mar int8, MIT). Input: float32 [1, 3, 640, 640]
// in BGR order, 0–255, not normalised. Outputs per stride (8, 16, 32), one row per grid cell:
// cls_s and obj_s [N, 1], bbox_s [N, 4] (cell offsets and log sizes), kps_s [N, 10] (5 landmarks).
// Decoding follows OpenCV's FaceDetectorYN. Works from close-ups down to faces of about 10 px.

export const YUNET_SIZE = 640;
const STRIDES = [8, 16, 32] as const;

export type Face = {
  /** Box in source pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
  /** Right eye, left eye, nose tip, right mouth corner, left mouth corner (the person's sides). */
  landmarks: [number, number][];
};

/** RGBA pixels of the 640×640 letterboxed frame → the model's planar BGR input. */
export function yunetInput(rgba: ArrayLike<number>): Float32Array {
  const plane = YUNET_SIZE * YUNET_SIZE;
  const out = new Float32Array(plane * 3);
  for (let p = 0; p < plane; p += 1) {
    out[p] = rgba[p * 4 + 2] ?? 0;
    out[plane + p] = rgba[p * 4 + 1] ?? 0;
    out[plane * 2 + p] = rgba[p * 4] ?? 0;
  }
  return out;
}

export type YunetOutputs = Record<string, ArrayLike<number>>;

function iou(a: Face, b: Face): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - overlap;
  return union > 0 ? overlap / union : 0;
}

/** Faces above `threshold`, best first, with overlapping duplicates removed. */
export function decodeYunet(outputs: YunetOutputs, box: FitBox, threshold = 0.6, nmsIou = 0.3): Face[] {
  const found: Face[] = [];
  for (const stride of STRIDES) {
    const cls = outputs[`cls_${stride}`];
    const obj = outputs[`obj_${stride}`];
    const bbox = outputs[`bbox_${stride}`];
    const kps = outputs[`kps_${stride}`];
    if (!cls || !obj || !bbox || !kps) continue;
    const cols = YUNET_SIZE / stride;
    const cells = cols * cols;
    for (let i = 0; i < cells; i += 1) {
      const clsScore = Math.min(1, Math.max(0, cls[i] ?? 0));
      const objScore = Math.min(1, Math.max(0, obj[i] ?? 0));
      const score = Math.sqrt(clsScore * objScore);
      if (score < threshold) continue;
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx = (col + (bbox[i * 4] ?? 0)) * stride;
      const cy = (row + (bbox[i * 4 + 1] ?? 0)) * stride;
      const w = Math.exp(bbox[i * 4 + 2] ?? 0) * stride;
      const h = Math.exp(bbox[i * 4 + 3] ?? 0) * stride;
      const [x, y] = toSource(box, cx - w / 2, cy - h / 2);
      const landmarks: [number, number][] = [];
      for (let k = 0; k < 5; k += 1) {
        landmarks.push(toSource(box, (col + (kps[i * 10 + k * 2] ?? 0)) * stride, (row + (kps[i * 10 + k * 2 + 1] ?? 0)) * stride));
      }
      found.push({ x, y, width: w / box.scale, height: h / box.scale, score, landmarks });
    }
  }
  found.sort((a, b) => b.score - a.score);
  const kept: Face[] = [];
  for (const face of found) {
    if (kept.every((k) => iou(k, face) <= nmsIou)) kept.push(face);
  }
  return kept;
}
