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
/** Below this mean brightness the photo is too dark for a try-on. */
const MIN_BRIGHTNESS = 55;
/** Body points must sit this share of the photo inside its edges: a knee guessed at the edge is cut off. */
const EDGE = 0.025;
/** Facing the camera, the shoulders are much wider than the face; turned sideways they aren't. */
const MIN_SHOULDERS_PER_FACE = 1.6;

export function judgeTryOnPhoto(analysis: PhotoAnalysis): TryOnPhotoCheck {
  const { pose, width, height } = analysis;
  const faces = analysis.faces ?? [];
  const inFrame = (name: keyof Pose) => {
    const point = pose?.[name];
    const [mx, my] = [width * EDGE, height * EDGE];
    return !!point && point.score >= SEEN && point.x >= mx && point.y >= my && point.x <= width - mx && point.y <= height - my;
  };
  const shoulders = inFrame("leftShoulder") && inFrame("rightShoulder");
  const lowerBody: (keyof Pose)[] = ["leftHip", "rightHip", "leftKnee", "rightKnee"];
  const bodyVisible = shoulders && lowerBody.every(inFrame);

  // Facing: one face, and the person's left shoulder on the picture's right, clearly wider than the face.
  // Only judged when there is a body to judge; an empty photo is reported as "body not visible".
  let facingForward = true;
  if (shoulders && pose) {
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

/**
 * The first check a photo failed, so the customer is told exactly what to change. Light comes first: in
 * a dark photo nothing else can be judged.
 */
export function photoProblem(check: TryOnPhotoCheck): AiFailureCode {
  if (!check.goodLight) return "PHOTO_TOO_DARK";
  if (!check.onePerson) return "PHOTO_NOT_ONE_PERSON";
  if (!check.facingForward) return "PHOTO_NOT_FACING";
  if (!check.bodyVisible) return "PHOTO_BODY_NOT_VISIBLE";
  return "PHOTO_REJECTED";
}

export function isUsable(check: TryOnPhotoCheck): boolean {
  return check.onePerson && check.facingForward && check.goodLight && check.bodyVisible;
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
