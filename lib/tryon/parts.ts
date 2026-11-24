import type { Keypoint, Pose } from "@/lib/vision/models/movenet";
import { PART, partAt, type BodyParts } from "@/lib/vision/models/parts";

import type { PersonAt } from "./mask";

// What the try-on keeps of the customer, read from the body-parts model (lib/vision/models/parts.ts)
// instead of guessed from colours (hair.ts, hands.ts, still used when the model isn't there): their hair
// and face, whatever the hair's colour, and the hands that are in sight. Pure, so it's unit-tested.

const SEEN = 0.3;
/** At least this share of skin where the hand would be, or it's taken as hidden (in a pocket, behind the back). */
const MIN_SKIN = 0.2;
/** More than this share of the chest's middle labelled hair: the model mistook a top for hair. */
const MAX_CHEST_HAIR = 0.35;

const seen = (k: Keypoint) => k.score >= SEEN;

/**
 * Hair and face to keep in front of the new garment (1 = keep), or null when the model's hair can't be
 * trusted (it covers the middle of the chest: a top the colour of the hair).
 */
export function hairFromParts(parts: BodyParts, pose: Pose): PersonAt | null {
  const { leftShoulder: ls, rightShoulder: rs } = pose;
  if (seen(ls) && seen(rs)) {
    const span = Math.max(1, Math.abs(ls.x - rs.x));
    const centreX = (ls.x + rs.x) / 2;
    const shoulderY = (ls.y + rs.y) / 2;
    let all = 0;
    let hair = 0;
    const step = Math.max(1, span / 40);
    for (let y = shoulderY + 0.2 * span; y <= shoulderY + 0.8 * span; y += step) {
      for (let x = centreX - 0.25 * span; x <= centreX + 0.25 * span; x += step) {
        const part = partAt(parts, x, y);
        if (part === PART.background) continue;
        all += 1;
        if (part === PART.hair) hair += 1;
      }
    }
    if (all > 0 && hair / all > MAX_CHEST_HAIR) return null;
  }
  return (x, y) => {
    const part = partAt(parts, x, y);
    return part === PART.hair || part === PART.faceSkin ? 1 : 0;
  };
}

/**
 * Whether each hand is in sight (true) or hidden (false: in a pocket, behind the back): skin where the
 * hand would be, just past the wrist. A wrist the body points didn't find counts as visible.
 */
export function handsFromParts(parts: BodyParts, pose: Pose): { left: boolean; right: boolean } {
  const { leftShoulder, rightShoulder } = pose;
  const span = Math.max(1, Math.hypot(leftShoulder.x - rightShoulder.x, leftShoulder.y - rightShoulder.y));
  const hand = (elbow: Keypoint, wrist: Keypoint): boolean => {
    if (!seen(wrist)) return true;
    const dx = seen(elbow) ? wrist.x - elbow.x : 0;
    const dy = seen(elbow) ? wrist.y - elbow.y : 1;
    const length = Math.max(1e-6, Math.hypot(dx, dy));
    const cx = wrist.x + (dx / length) * span * 0.1;
    const cy = wrist.y + (dy / length) * span * 0.1;
    const r = span * 0.2;
    const step = Math.max(1, r / 12);
    let all = 0;
    let skin = 0;
    for (let y = cy - r; y <= cy + r; y += step) {
      for (let x = cx - r; x <= cx + r; x += step) {
        if (Math.hypot(x - cx, y - cy) > r) continue;
        all += 1;
        if (partAt(parts, x, y) === PART.bodySkin) skin += 1;
      }
    }
    return all === 0 || skin / all >= MIN_SKIN;
  };
  return { left: hand(pose.leftElbow, pose.leftWrist), right: hand(pose.rightElbow, pose.rightWrist) };
}
