import { describe, expect, it } from "vitest";

import type { Keypoint, Pose } from "@/lib/vision/movenet";
import { blendTryOn, tryOnCrop, tryOnMask } from "@/lib/tryon/mask";

// The area of a customer's photo the local try-on model may repaint: their clothes and room around
// them, never the face, hands, feet or the backdrop far from the body.

const W = 1000;
const H = 1000;
const at = (x: number, y: number, score = 0.9): Keypoint => ({ x, y, score });
function pose(overrides: Partial<Pose> = {}): Pose {
  return {
    nose: at(500, 120),
    leftEye: at(510, 110),
    rightEye: at(490, 110),
    leftEar: at(520, 115),
    rightEar: at(480, 115),
    leftShoulder: at(560, 220),
    rightShoulder: at(440, 220),
    // Arms hanging by the sides.
    leftElbow: at(580, 350),
    rightElbow: at(420, 350),
    leftWrist: at(585, 470),
    rightWrist: at(415, 470),
    leftHip: at(540, 470),
    rightHip: at(460, 470),
    leftKnee: at(540, 680),
    rightKnee: at(460, 680),
    leftAnkle: at(540, 880),
    rightAnkle: at(460, 880),
    ...overrides,
  };
}

function mask(reach: "hips" | "knees" | "ankles", overrides: Partial<Pose> = {}, person: ((x: number, y: number) => number) | null = null): (x: number, y: number) => boolean {
  const out = tryOnMask(pose(overrides), person, W, H, reach);
  if (!out) throw new Error("no mask");
  return (x, y) => out[Math.round(y) * W + Math.round(x)] === 255;
}

describe("tryOnMask", () => {
  it("repaints the torso, the lower neck and the arms, but not the face or the backdrop", () => {
    const m = mask("hips");
    expect(m(500, 300)).toBe(true); // chest
    expect(m(500, 190)).toBe(true); // lower neck: collars and necklines are redrawn
    expect(m(575, 300)).toBe(true); // upper arm: sleeves may change
    expect(m(500, 120)).toBe(false); // nose
    expect(m(500, 150)).toBe(false); // chin
    expect(m(100, 300)).toBe(false); // backdrop
  });

  it("keeps the hands", () => {
    const m = mask("hips");
    expect(m(586, 500)).toBe(false);
    expect(m(414, 500)).toBe(false);
  });

  it("reaches as far down as the garment: shirts below the hips, panjabis to the knees, dresses to the ankles", () => {
    const shirt = mask("hips");
    const panjabi = mask("knees");
    const dress = mask("ankles");
    expect(shirt(500, 500)).toBe(true);
    expect(shirt(500, 650)).toBe(false);
    expect(panjabi(500, 650)).toBe(true);
    expect(panjabi(500, 800)).toBe(false);
    expect(dress(500, 850)).toBe(true);
    expect(dress(500, 950)).toBe(false); // feet
  });

  it("leaves room for a skirt to be wider than the legs it covers", () => {
    const dress = mask("ankles");
    // Well outside the legs (460–540) near the hem.
    expect(dress(415, 860)).toBe(true);
    expect(dress(585, 860)).toBe(true);
  });

  it("also repaints the person's own clothes that stick out further, within reason", () => {
    // A wide own skirt (the person mask) out to 320–680 at knee height.
    const person = (x: number, y: number) => (y > 600 && y < 700 && x > 320 && x < 680 ? 1 : 0);
    const without = mask("knees");
    const withSkirt = mask("knees", {}, person);
    expect(without(335, 650)).toBe(false);
    expect(withSkirt(335, 650)).toBe(true);
  });

  it("guesses the legs when the model doesn't see them, and needs only the shoulders", () => {
    const unseen = at(0, 0, 0.05);
    const dress = mask("ankles", { leftKnee: unseen, rightKnee: unseen, leftAnkle: unseen, rightAnkle: unseen });
    expect(dress(500, 700)).toBe(true);
    expect(tryOnMask(pose({ leftShoulder: unseen }), null, W, H, "hips")).toBeNull();
  });

  it("works on a half-body photo: the garment runs down to the photo's edge", () => {
    const unseen = at(0, 0, 0.05);
    const below = { leftHip: unseen, rightHip: unseen, leftKnee: unseen, rightKnee: unseen, leftAnkle: unseen, rightAnkle: unseen };
    // The photo ends at the waist (y 420).
    const out = tryOnMask(pose(below), null, W, 420, "ankles");
    if (!out) throw new Error("no mask");
    const m = (x: number, y: number) => out[y * W + x] === 255;
    expect(m(500, 300)).toBe(true);
    expect(m(500, 419)).toBe(true);
    expect(m(500, 120)).toBe(false);
  });

  it("stays body-wide for someone standing sideways, whose shoulders overlap", () => {
    // Shoulders 20 px apart, but the head (nose to shoulders 100 px) says the body is far wider.
    const side = mask("hips", { leftShoulder: at(510, 220), rightShoulder: at(490, 220), leftHip: at(505, 470), rightHip: at(495, 470) });
    expect(side(560, 330)).toBe(true);
    expect(side(440, 330)).toBe(true);
  });
});

describe("tryOnMask with a fit", () => {
  const count = (m: Uint8Array | null, y: number) => {
    let n = 0;
    for (let x = 0; x < W; x += 1) if (m?.[y * W + x] === 255) n += 1;
    return n;
  };

  it("is wider for a size too big and narrower for one too small", () => {
    const as = tryOnMask(pose(), null, W, H, "ankles");
    const loose = tryOnMask(pose(), null, W, H, "ankles", { fit: { width: 1.2, hemLevel: null } });
    const tight = tryOnMask(pose(), null, W, H, "ankles", { fit: { width: 0.88, hemLevel: null } });
    expect(count(loose, 700)).toBeGreaterThan(count(as, 700));
    expect(count(tight, 700)).toBeLessThan(count(as, 700));
  });

  it("ends a dress where its hem lands, keeping the photo below it", () => {
    // Knee level: 0.285 of their height above the floor → the knee points (y 680).
    const knee = tryOnMask(pose(), null, W, H, "ankles", { fit: { width: 1, hemLevel: 0.285 } });
    if (!knee) throw new Error("no mask");
    const at = (x: number, y: number) => knee[y * W + x] === 255;
    expect(at(420, 650)).toBe(true);
    expect(at(500, 682)).toBe(true);
    expect(at(540, 800)).toBe(false);
    expect(at(500, 800)).toBe(false);
  });

  it("reaches the ankles as before when the hem would be at or below them", () => {
    const long = tryOnMask(pose(), null, W, H, "ankles", { fit: { width: 1, hemLevel: 0.01 } });
    expect(long?.[850 * W + 500]).toBe(255);
  });
});

describe("tryOnMask keeps the body's shape", () => {
  /** A slim person: torso 100 px wide down to the hips, legs below, arms (with a gap) by the sides. */
  const slim = (x: number, y: number) => {
    if (y < 60 || y > 900) return 0;
    if (y < 200) return Math.abs(x - 500) <= 30 ? 1 : 0;
    if (y <= 480 && Math.abs(x - 500) <= 50) return 1;
    if (y > 480 && (Math.abs(x - 460) <= 25 || Math.abs(x - 540) <= 25)) return 1;
    return y <= 480 && Math.abs(Math.abs(x - 500) - 85) <= 10 ? 1 : 0;
  };
  const at = (m: Uint8Array | null, x: number, y: number) => m?.[y * W + x] === 255;

  it("hugs the person's outline above the hips, where the plain outline would be wider", () => {
    const followed = tryOnMask(pose(), slim, W, H, "ankles");
    const plain = tryOnMask(pose(), null, W, H, "ankles");
    expect(at(followed, 553, 300)).toBe(true); // just past the side: a small margin
    expect(at(plain, 562, 300)).toBe(true);
    expect(at(followed, 562, 300)).toBe(false); // the gap between arm and body stays
    expect(at(followed, 580, 300)).toBe(true); // the arm itself (sleeves may change)
    expect(at(followed, 610, 300)).toBe(false);
    // A person mask that missed them: the plain outline, not nothing.
    expect(at(tryOnMask(pose(), () => 0, W, H, "ankles"), 562, 300)).toBe(true);
  });

  it("lets a size too big stand off the body, and never cuts into the body for one too small", () => {
    const loose = tryOnMask(pose(), slim, W, H, "ankles", { fit: { width: 1.3, hemLevel: null } });
    const tight = tryOnMask(pose(), slim, W, H, "ankles", { fit: { width: 0.85, hemLevel: null } });
    expect(at(loose, 562, 300)).toBe(true);
    for (const x of [452, 500, 548]) expect(at(tight, x, 300)).toBe(true);
  });

  it("lets a skirt stand away from the legs below the hips, but not a shirt", () => {
    expect(at(tryOnMask(pose(), slim, W, H, "ankles"), 580, 650)).toBe(true);
    expect(at(tryOnMask(pose(), null, W, H, "hips"), 578, 520)).toBe(true);
    expect(at(tryOnMask(pose(), slim, W, H, "hips"), 578, 520)).toBe(false);
  });

  it("keeps the wrists (bracelets, a watch) and anything marked to keep", () => {
    const m = tryOnMask(pose(), null, W, H, "hips");
    expect(at(m, 585, 465)).toBe(false);
    expect(at(m, 582, 420)).toBe(true); // the forearm above it
    const hair = (x: number, y: number) => (Math.abs(x - 530) <= 8 && y < 260 ? 1 : 0);
    const kept = tryOnMask(pose(), null, W, H, "hips", { keep: hair });
    expect(at(kept, 530, 230)).toBe(false);
    expect(at(kept, 500, 230)).toBe(true);
  });
});

describe("tryOnCrop and blendTryOn", () => {
  it("picks the largest 3:4 box that holds the mask, inside the photo", () => {
    const width = 1200;
    const height = 1000;
    const m = new Uint8Array(width * height);
    for (let y = 100; y < 900; y += 1) for (let x = 900; x < 1000; x += 1) m[y * width + x] = 255;
    const box = tryOnCrop(m, width, height);
    // Centred on the mask it would stick out on the right, so it stops at the edge.
    expect(box).toEqual({ left: 450, top: 0, width: 750, height: 1000 });
  });

  it("is the photo itself when the photo is already 3:4", () => {
    const m = new Uint8Array(300 * 400);
    m[200 * 300 + 150] = 255;
    expect(tryOnCrop(m, 300, 400)).toEqual({ left: 0, top: 0, width: 300, height: 400 });
  });

  it("takes the model's pixels inside the mask and keeps the photo's elsewhere", () => {
    const photo = Uint8Array.from([10, 10, 10, 10, 10, 10, 10, 10, 10]);
    const result = Uint8Array.from([200, 200, 200, 200, 200, 200, 200, 200, 200]);
    blendTryOn(photo, result, Uint8Array.from([0, 255, 128]));
    expect([...photo]).toEqual([10, 10, 10, 200, 200, 200, 105, 105, 105]);
  });
});
