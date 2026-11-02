import { readFileSync } from "node:fs";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { LocalPhotoChecker } from "@/lib/ai/photo-check-local";
import type { Keypoint, Pose } from "@/lib/vision/movenet";
import { KEYPOINT_NAMES } from "@/lib/vision/movenet";
import { nodeModelsPresent } from "@/lib/vision/node-vision";
import { isUsable, judgeTryOnPhoto, meanBrightness, photoProblem, type PhotoAnalysis } from "@/lib/vision/photo-check";
import { fitSquare } from "@/lib/vision/geometry";
import type { Face } from "@/lib/vision/yunet";

// Try-on photo rules (shared by the browser and the worker), and the worker's checker on our own
// AI-generated test photos (tests/fixtures/tryon-*.jpg: people who don't exist).

const W = 600;
const H = 1000;

/** A person facing the camera: their left shoulder on the picture's right. */
function facingPose(overrides: Partial<Record<keyof Pose, Keypoint>> = {}): Pose {
  const at = (x: number, y: number): Keypoint => ({ x, y, score: 0.9 });
  const base: Pose = {
    nose: at(300, 120),
    leftEye: at(315, 110),
    rightEye: at(285, 110),
    leftEar: at(330, 115),
    rightEar: at(270, 115),
    leftShoulder: at(390, 230),
    rightShoulder: at(210, 230),
    leftElbow: at(410, 380),
    rightElbow: at(190, 380),
    leftWrist: at(415, 510),
    rightWrist: at(185, 510),
    leftHip: at(350, 520),
    rightHip: at(250, 520),
    leftKnee: at(345, 720),
    rightKnee: at(255, 720),
    leftAnkle: at(345, 920),
    rightAnkle: at(255, 920),
  };
  return { ...base, ...overrides };
}

const face = (x = 260): Face => ({ x, y: 70, width: 80, height: 100, score: 0.9, landmarks: [] });
const analysis = (overrides: Partial<PhotoAnalysis> = {}): PhotoAnalysis => ({ width: W, height: H, pose: facingPose(), faces: [face()], brightness: 150, ...overrides });

describe("try-on photo rules", () => {
  it("notes one person facing the camera in good light", () => {
    expect(judgeTryOnPhoto(analysis())).toEqual({ onePerson: true, facingForward: true, goodLight: true, bodyVisible: true });
  });

  it("uses any photo with a person's shoulders in it, refusing only one with nobody found", () => {
    const problem = (a: Partial<PhotoAnalysis>) => {
      const check = judgeTryOnPhoto(analysis(a));
      return isUsable(check) ? "OK" : photoProblem(check);
    };
    // Other people, dim light, turned sideways or away: still used (noted for the metrics).
    expect(problem({ faces: [face(100), face(400)], brightness: 30 })).toBe("OK");
    expect(problem({ faces: [] })).toBe("OK");
    const p = facingPose();
    expect(problem({ pose: { ...p, leftShoulder: p.rightShoulder, rightShoulder: p.leftShoulder } })).toBe("OK");
    expect(judgeTryOnPhoto(analysis({ faces: [] })).facingForward).toBe(false);
    // Half-body photo or selfie: no hips or knees in the picture.
    const unseen = { x: 0, y: 0, score: 0.05 };
    expect(problem({ pose: facingPose({ leftHip: unseen, rightHip: unseen, leftKnee: unseen, rightKnee: unseen, leftAnkle: unseen, rightAnkle: unseen }) })).toBe("OK");
    // Nobody at all.
    const nobody = Object.fromEntries(KEYPOINT_NAMES.map((n) => [n, unseen]));
    expect(problem({ faces: [], pose: { ...facingPose(), ...nobody } })).toBe("PHOTO_BODY_NOT_VISIBLE");
    expect(problem({ pose: null })).toBe("PHOTO_BODY_NOT_VISIBLE");
  });

  it("measures brightness inside the picture only, not the letterbox padding", () => {
    const box = fitSquare(2, 4, 4); // 2×4 picture in a 4×4 square: columns 1–2
    const rgba = new Uint8ClampedArray(4 * 4 * 4);
    for (let y = 0; y < 4; y += 1) for (let x = 1; x < 3; x += 1) rgba.set([200, 200, 200, 255], (y * 4 + x) * 4);
    expect(meanBrightness(rgba, box)).toBeCloseTo(200);
  });
});

describe.skipIf(!nodeModelsPresent())("the worker's on-device photo check (real models)", () => {
  const checker = new LocalPhotoChecker();
  const signal = new AbortController().signal;
  const check = async (data: Buffer) => {
    const result = await checker.checkTryOnPhoto({ data, mimeType: "image/webp" }, signal);
    return isUsable(result) ? "OK" : photoProblem(result);
  };
  const woman = readFileSync("tests/fixtures/tryon-woman.jpg");
  const man = readFileSync("tests/fixtures/tryon-man.jpg");

  it("accepts full-length photos of one person facing the camera", async () => {
    expect(await check(woman)).toBe("OK");
    expect(await check(man)).toBe("OK");
  }, 30_000);

  it("also accepts half-body, landscape, dim and group photos", async () => {
    const top = await sharp(woman).extract({ left: 0, top: 0, width: 600, height: 560 }).jpeg().toBuffer();
    expect(await check(top)).toBe("OK");
    expect(await check(await sharp(woman).modulate({ brightness: 0.4 }).jpeg().toBuffer())).toBe("OK");
    const pair = await sharp({ create: { width: 1200, height: 1067, channels: 3, background: "#ddd" } })
      .composite([
        { input: woman, left: 0, top: 0 },
        { input: man, left: 600, top: 0 },
      ])
      .jpeg()
      .toBuffer();
    expect(await check(pair)).toBe("OK");
  }, 30_000);

  it("refuses a photo with nobody in it", async () => {
    const empty = await sharp({ create: { width: 600, height: 800, channels: 3, background: "#cfd4da" } }).jpeg().toBuffer();
    expect(await check(empty)).toBe("PHOTO_BODY_NOT_VISIBLE");
  }, 30_000);
});
