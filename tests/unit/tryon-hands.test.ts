import { describe, expect, it } from "vitest";

import { visibleHands } from "@/lib/tryon/hands";
import type { Keypoint, Pose } from "@/lib/vision/movenet";

// Whether a person's hands are in sight in their photo, by the skin colour of their own face: a hand in a
// pocket isn't kept by the try-on (its spot would keep the old pocket).

const W = 300;
const H = 400;
const SKIN = [150, 105, 80] as const;
const JACKET = [22, 22, 25] as const;
const at = (x: number, y: number, score = 0.9): Keypoint => ({ x, y, score });
const unseen = at(0, 0, 0);
const POSE: Pose = {
  nose: at(150, 60),
  leftEye: at(160, 50),
  rightEye: at(140, 50),
  leftEar: unseen,
  rightEar: unseen,
  leftShoulder: at(190, 100),
  rightShoulder: at(110, 100),
  leftElbow: at(200, 170),
  rightElbow: at(100, 170),
  leftWrist: at(200, 230),
  rightWrist: at(100, 230),
  leftHip: at(175, 240),
  rightHip: at(125, 240),
  leftKnee: unseen,
  rightKnee: unseen,
  leftAnkle: unseen,
  rightAnkle: unseen,
};

/** A dark jacket everywhere, a face, and a bare hand on the person's right only. */
function photo(): Uint8Array {
  const rgb = new Uint8Array(W * H * 3);
  for (let p = 0; p < W * H; p += 1) rgb.set(JACKET, p * 3);
  const paint = (cx: number, cy: number, r: number) => {
    for (let y = cy - r; y <= cy + r; y += 1) for (let x = cx - r; x <= cx + r; x += 1) if (Math.hypot(x - cx, y - cy) <= r) rgb.set(SKIN, (y * W + x) * 3);
  };
  paint(150, 55, 28); // face
  paint(100, 242, 16); // right hand, just past the wrist
  return rgb;
}

describe("hands in sight", () => {
  it("sees a bare hand and not one hidden in a dark pocket", () => {
    expect(visibleHands(photo(), W, H, POSE)).toEqual({ left: false, right: true });
  });

  it("assumes both are in sight when there's no face to learn the skin from", () => {
    expect(visibleHands(photo(), W, H, { ...POSE, nose: unseen })).toEqual({ left: true, right: true });
  });
});
