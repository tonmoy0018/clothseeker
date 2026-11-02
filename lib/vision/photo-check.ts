import type { AiFailureCode } from "@/lib/ai/errors";
import type { TryOnPhotoCheck } from "@/lib/ai/types";

import type { FitBox } from "./geometry";
import type { Pose } from "./movenet";
import type { Face } from "./yunet";

// Whether a photo works for a try-on, judged from the on-device models' findings. The same rules run in
// the customer's browser (instant feedback, before upload) and in the worker (the check customers can't
// skip). Pure, so both give the same answer.

export type PhotoAnalysis = {
  width: number;
  height: number;
  pose: Pose | null;
  faces: Face[] | null;
  /** Mean brightness of the photo, 0–255. */
  brightness: number | null;
};

/** A keypoint the model is reasonably sure of. */
const SEEN = 0.3;
/** Below this mean brightness the photo is dim (noted, not refused). */
const MIN_BRIGHTNESS = 55;
/** Facing the camera, the shoulders are much wider than the face; turned sideways they aren't. */
const MIN_SHOULDERS_PER_FACE = 1.6;

/**
 * Any photo with a person in it can be used (decided 2026-11-02): the try-on only needs to find their
 * shoulders. Half-body photos, selfies, landscape photos, side views, dim light and other people in
 * the picture are fine: the garment goes on the main person, down to the photo's edge. The other
 * findings are kept for the worker's log and the AI metrics, not to refuse the photo.
 */
export function judgeTryOnPhoto(analysis: PhotoAnalysis): TryOnPhotoCheck {
  const { pose, width, height } = analysis;
  const faces = analysis.faces ?? [];
  const found = (name: keyof Pose) => {
    const point = pose?.[name];
    return !!point && point.score >= SEEN && point.x >= 0 && point.y >= 0 && point.x <= width && point.y <= height;
  };
  const bodyVisible = found("leftShoulder") && found("rightShoulder");

  let facingForward = true;
  if (bodyVisible && pose) {
    const face = faces[0];
    const span = pose.leftShoulder.x - pose.rightShoulder.x;
    facingForward = !!face && span > 0 && span >= MIN_SHOULDERS_PER_FACE * face.width;
  }

  return {
    onePerson: faces.length <= 1,
    facingForward,
    goodLight: analysis.brightness === null || analysis.brightness >= MIN_BRIGHTNESS,
    bodyVisible,
  };
}

/** Why a photo can't be used: only when no person was found in it. */
export function photoProblem(check: TryOnPhotoCheck): AiFailureCode {
  return check.bodyVisible ? "PHOTO_REJECTED" : "PHOTO_BODY_NOT_VISIBLE";
}

export function isUsable(check: TryOnPhotoCheck): boolean {
  return check.bodyVisible;
}

/** Mean brightness (0–255) of the picture inside a letterboxed RGBA square (padding excluded). */
export function meanBrightness(rgba: ArrayLike<number>, box: FitBox): number {
  let sum = 0;
  let count = 0;
  for (let y = box.offsetY; y < box.offsetY + box.height; y += 1) {
    for (let x = box.offsetX; x < box.offsetX + box.width; x += 1) {
      const p = (y * box.size + x) * 4;
      sum += 0.2126 * (rgba[p] ?? 0) + 0.7152 * (rgba[p + 1] ?? 0) + 0.0722 * (rgba[p + 2] ?? 0);
      count += 1;
    }
  }
  return count > 0 ? sum / count : 0;
}
