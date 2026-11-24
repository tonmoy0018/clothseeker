import type { Keypoint, Pose } from "@/lib/vision/models/movenet";

// Whether a person's hands can be seen in their try-on photo. The try-on keeps visible hands as they are
// (lib/tryon/mask.ts); a hand in a pocket isn't there to keep, and keeping its spot would keep the old
// pocket (a black patch like a glove where a jacket pocket was). Skin is recognised by the face's own
// colour: its hue and its colourfulness relative to its lightness, which shading changes little.
// Pure, so it's unit-tested.

const SEEN = 0.3;
/** At least this share of skin where the hand would be, or it's taken as hidden. */
const MIN_SKIN = 0.2;
const HUE_TOLERANCE = (20 * Math.PI) / 180;

type Lab = [number, number, number];

function toLab(r: number, g: number, b: number): Lab {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [lr, lg, lb] = [lin(r), lin(g), lin(b)];
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const x = f((0.4124 * lr + 0.3576 * lg + 0.1805 * lb) / 0.95047);
  const y = f(0.2126 * lr + 0.7152 * lg + 0.0722 * lb);
  const z = f((0.0193 * lr + 0.1192 * lg + 0.9505 * lb) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

/**
 * Whether each hand is in sight (true) or hidden (false: in a pocket, behind the back). Unknown (no
 * face to learn the skin from, or no wrist found) counts as visible, as before.
 */
export function visibleHands(rgb: ArrayLike<number>, width: number, height: number, pose: Pose): { left: boolean; right: boolean } {
  const seen = (k: Keypoint) => k.score >= SEEN;
  const { leftEye, rightEye, nose, leftShoulder, rightShoulder } = pose;
  if (![leftEye, rightEye, nose, leftShoulder, rightShoulder].every(seen)) return { left: true, right: true };
  const at = (x: number, y: number): Lab => {
    const i = (Math.round(y) * width + Math.round(x)) * 3;
    return toLab(rgb[i] ?? 0, rgb[i + 1] ?? 0, rgb[i + 2] ?? 0);
  };
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height;

  // The face below the eyes: cheeks and nose.
  const eyeGap = Math.max(2, Math.abs(leftEye.x - rightEye.x));
  const eyeY = (leftEye.y + rightEye.y) / 2;
  const face: Lab[] = [];
  for (let y = Math.round(eyeY + 0.3 * (nose.y - eyeY)); y <= nose.y; y += 1) {
    for (let x = Math.round(nose.x - 0.4 * eyeGap); x <= nose.x + 0.4 * eyeGap; x += 1) if (inside(x, y)) face.push(at(x, y));
  }
  if (face.length < 8) return { left: true, right: true };
  const skinL = median(face.map((c) => c[0]));
  const skinA = median(face.map((c) => c[1]));
  const skinB = median(face.map((c) => c[2]));
  const skinChroma = Math.hypot(skinA, skinB);
  if (skinChroma < 6 || skinL < 5) return { left: true, right: true };
  const skinHue = Math.atan2(skinB, skinA);
  const isSkin = (c: Lab) => {
    const chroma = Math.hypot(c[1], c[2]);
    if (c[0] < 3 || c[0] < skinL - 40 || c[0] > skinL + 30 || chroma < 4) return false;
    const hueOff = Math.abs(((Math.atan2(c[2], c[1]) - skinHue + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
    const ratio = chroma / c[0] / (skinChroma / skinL);
    return hueOff <= HUE_TOLERANCE && ratio >= 0.5 && ratio <= 1.8;
  };

  // Where each hand would be: just past the wrist, along the forearm (as the mask keeps it).
  const span = Math.max(1, Math.hypot(leftShoulder.x - rightShoulder.x, leftShoulder.y - rightShoulder.y));
  const hand = (elbow: Keypoint, wrist: Keypoint): boolean => {
    if (!seen(wrist)) return true;
    const dx = seen(elbow) ? wrist.x - elbow.x : 0;
    const dy = seen(elbow) ? wrist.y - elbow.y : 1;
    const length = Math.max(1e-6, Math.hypot(dx, dy));
    const cx = wrist.x + (dx / length) * span * 0.1;
    const cy = wrist.y + (dy / length) * span * 0.1;
    const r = span * 0.2;
    let all = 0;
    let skin = 0;
    for (let y = Math.round(cy - r); y <= cy + r; y += 2) {
      for (let x = Math.round(cx - r); x <= cx + r; x += 2) {
        if (!inside(x, y) || Math.hypot(x - cx, y - cy) > r) continue;
        all += 1;
        if (isSkin(at(x, y))) skin += 1;
      }
    }
    return all === 0 || skin / all >= MIN_SKIN;
  };
  return { left: hand(pose.leftElbow, pose.leftWrist), right: hand(pose.rightElbow, pose.rightWrist) };
}
