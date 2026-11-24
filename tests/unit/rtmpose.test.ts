import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import * as ort from "onnxruntime-web";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { fitSquare } from "@/lib/vision/models/geometry";
import { KEYPOINT_NAMES, type Keypoint, type Pose } from "@/lib/vision/models/movenet";
import { BodyTracker, CROP_HOLD, cropFor, decodeRtmpose, maskBox, poseBox, RTMPOSE_HEIGHT, RTMPOSE_WIDTH, rtmposeInput, unionBox, type Box } from "@/lib/vision/models/rtmpose";
import { modelPath, modelSourceUrl, VISION_MODELS } from "@/lib/vision/runtime/assets";

// The live mirror's body model (RTMPose-s): its input, decoding and person tracking, and the real model
// on our AI-generated test person (tests/fixtures/tryon-woman.jpg: someone who doesn't exist).

const pose = (at: (name: (typeof KEYPOINT_NAMES)[number], i: number) => Keypoint): Pose => {
  const entries = KEYPOINT_NAMES.map((name, i) => at(name, i));
  const [nose, leftEye, rightEye, leftEar, rightEar, leftShoulder, rightShoulder, leftElbow, rightElbow, leftWrist, rightWrist, leftHip, rightHip, leftKnee, rightKnee, leftAnkle, rightAnkle] = entries;
  const need = (p: Keypoint | undefined): Keypoint => p ?? { x: 0, y: 0, score: 0 };
  return {
    nose: need(nose),
    leftEye: need(leftEye),
    rightEye: need(rightEye),
    leftEar: need(leftEar),
    rightEar: need(rightEar),
    leftShoulder: need(leftShoulder),
    rightShoulder: need(rightShoulder),
    leftElbow: need(leftElbow),
    rightElbow: need(rightElbow),
    leftWrist: need(leftWrist),
    rightWrist: need(rightWrist),
    leftHip: need(leftHip),
    rightHip: need(rightHip),
    leftKnee: need(leftKnee),
    rightKnee: need(rightKnee),
    leftAnkle: need(leftAnkle),
    rightAnkle: need(rightAnkle),
  };
};

describe("RTMPose input and decoding", () => {
  it("takes planar RGB normalised with ImageNet's mean and spread", () => {
    const rgba = new Uint8ClampedArray(RTMPOSE_WIDTH * RTMPOSE_HEIGHT * 4);
    rgba.set([123.675, 116.28, 103.53, 255], 0);
    rgba.set([255, 0, 0, 255], 4);
    const input = rtmposeInput(rgba);
    const plane = RTMPOSE_WIDTH * RTMPOSE_HEIGHT;
    expect(input.length).toBe(plane * 3);
    expect(input[0]).toBeCloseTo((124 - 123.675) / 58.395, 5); // 124 once stored as a byte
    expect(input[1]).toBeCloseTo((255 - 123.675) / 58.395, 4);
    expect(input[plane + 1]).toBeCloseTo(-116.28 / 57.12, 4);
  });

  it("crops around the person in the model's 3:4 shape, grown by a quarter", () => {
    const wide = cropFor({ x: 100, y: 100, width: 300, height: 200 });
    expect(wide.width / wide.height).toBeCloseTo(3 / 4);
    expect(wide.width).toBeCloseTo(375);
    expect(wide.x + wide.width / 2).toBeCloseTo(250);
    const tall = cropFor({ x: 0, y: 0, width: 100, height: 400 });
    expect(tall.height).toBeCloseTo(500);
    expect(tall.width).toBeCloseTo(375);
  });

  it("reads each keypoint's strongest bins back into frame pixels, scores clamped to 0–1", () => {
    const binsX = RTMPOSE_WIDTH * 2;
    const binsY = RTMPOSE_HEIGHT * 2;
    const x = new Float32Array(17 * binsX);
    const y = new Float32Array(17 * binsY);
    x[5 * binsX + binsX / 4] = 1.2; // left shoulder: a quarter across…
    y[5 * binsY + binsY / 2] = 0.9; // …half way down
    x[0 * binsX + 10] = 0.2;
    y[0 * binsY + 10] = 0.6;
    const crop: Box = { x: 40, y: 20, width: 300, height: 400 };
    const decoded = decodeRtmpose(x, y, crop);
    expect(decoded.leftShoulder).toMatchObject({ x: 40 + 75, y: 20 + 200 });
    expect(decoded.leftShoulder.score).toBeCloseTo(0.9);
    expect(decoded.nose.score).toBeCloseTo(0.2); // the weaker axis
    expect(decodeRtmpose(x.map((v) => v * 2), y.map((v) => v * 2), crop).leftShoulder.score).toBe(1);
  });

  it("reads a peak between two bins to a fraction of a bin, so noise doesn't make joints jump a bin", () => {
    const binsX = RTMPOSE_WIDTH * 2;
    const binsY = RTMPOSE_HEIGHT * 2;
    const x = new Float32Array(17 * binsX);
    const y = new Float32Array(17 * binsY);
    const crop: Box = { x: 0, y: 0, width: binsX, height: binsY }; // one source pixel a bin
    // A peak a quarter of a bin to the right of bin 100: its right neighbour is stronger than its left.
    x[100 - 1] = 0.5;
    x[100] = 0.9;
    x[100 + 1] = 0.7;
    y[200] = 0.9; // a lone bin stays where it is
    const nose = decodeRtmpose(x, y, crop).nose;
    expect(nose.x).toBeCloseTo(100 + (0.5 - 0.7) / (2 * (0.5 - 1.8 + 0.7)), 5);
    expect(nose.x).toBeGreaterThan(100);
    expect(nose.x).toBeLessThan(100.5);
    expect(nose.y).toBe(200);
    expect(nose.score).toBeCloseTo(0.9);
  });
});

describe("tracking the person between frames", () => {
  const standing = pose((name, i) => ({ x: 200 + (name.startsWith("left") ? 40 : name.startsWith("right") ? -40 : 0), y: 100 + i * 20, score: 0.9 }));

  it("follows the last pose, grown for the head and movement", () => {
    const box = poseBox(standing);
    expect(box).not.toBeNull();
    if (!box) return;
    for (const name of KEYPOINT_NAMES) {
      const p = standing[name];
      expect(p.x).toBeGreaterThan(box.x);
      expect(p.x).toBeLessThan(box.x + box.width);
      expect(p.y).toBeGreaterThan(box.y);
      expect(p.y).toBeLessThan(box.y + box.height);
    }
    expect(box.y).toBeLessThan(100 - 40); // well above the nose: the top of the head
  });

  it("lets go when the shoulders are lost or too little is sure", () => {
    expect(poseBox({ ...standing, leftShoulder: { ...standing.leftShoulder, score: 0.1 } })).toBeNull();
    expect(poseBox(pose((name) => ({ x: 1, y: 1, score: name.endsWith("Shoulder") ? 0.9 : 0.1 })))).toBeNull();
  });

  it("finds the person from the outline, in frame pixels", () => {
    const box = fitSquare(512, 256, 256); // scale 0.5, offsetY 64
    const alpha = new Float32Array(256 * 256);
    for (let y = 70; y < 120; y += 1) for (let x = 50; x < 60; x += 1) alpha[y * 256 + x] = 0.9;
    expect(maskBox({ alpha, width: 256, height: 256, box })).toEqual({ x: 100, y: 12, width: 20, height: 100 });
    expect(maskBox({ alpha: new Float32Array(256 * 256), width: 256, height: 256, box })).toBeNull();
  });

  it("joins the pose's box and the outline's", () => {
    expect(unionBox({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 20, height: 2 })).toEqual({ x: 0, y: 0, width: 25, height: 10 });
    expect(unionBox(null, { x: 1, y: 2, width: 3, height: 4 })).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(unionBox(null, null)).toBeNull();
  });

  it("looks in the same box on every frame, not a wider one on the frames the outline runs", () => {
    const tracker = new BodyTracker();
    const outline: Box = { x: 100, y: 20, width: 200, height: 480 };
    const first = tracker.next(640, 520, outline);
    tracker.found(standing);
    const withOutline = tracker.next(640, 520, outline);
    tracker.found(standing);
    const without = tracker.next(640, 520, null);
    expect(first).toEqual(cropFor(outline));
    expect(without).toEqual(withOutline);
  });

  it("holds the box while the person stays inside it, and follows a real move", () => {
    const tracker = new BodyTracker();
    const outline: Box = { x: 100, y: 20, width: 200, height: 480 };
    const held = tracker.next(640, 520, outline);
    // A few pixels of jitter: the same crop.
    expect(tracker.next(640, 520, { ...outline, x: outline.x + 3, width: outline.width + 2 })).toBe(held);
    // A step sideways (more than CROP_HOLD of the crop): the crop follows.
    const moved = tracker.next(640, 520, { ...outline, x: outline.x + held.width * CROP_HOLD * 2 });
    expect(moved.x).toBeGreaterThan(held.x);
    // Stepping back (the person gets much smaller): it follows too.
    const back = tracker.next(640, 520, { x: 150, y: 120, width: 100, height: 240 });
    expect(back.width).toBeLessThan(moved.width * 0.8);
  });

  it("starts afresh in a frame of another size, with the whole frame when nothing is known", () => {
    const tracker = new BodyTracker();
    tracker.next(640, 520, { x: 100, y: 20, width: 200, height: 480 });
    tracker.found(standing);
    expect(tracker.next(300, 400, null)).toEqual(cropFor({ x: 0, y: 0, width: 300, height: 400 }));
  });

  it("is fetched from OpenMMLab's own zip and pinned like the others", () => {
    expect(modelSourceUrl(VISION_MODELS.body)).toMatch(/^https:\/\/download\.openmmlab\.com\/.+\.zip$/);
    expect(modelSourceUrl(VISION_MODELS.pose)).toMatch(/^https:\/\/huggingface\.co\//);
  });
});

const BODY_FILE = path.join(process.cwd(), "public", modelPath(VISION_MODELS.body));

describe.skipIf(!existsSync(BODY_FILE))("RTMPose on a real photo", () => {
  /** The crop as the browser draws it: the whole frame scaled and shifted, black outside it. */
  async function cropPixels(image: Buffer, crop: Box): Promise<Buffer> {
    const meta = await sharp(image).metadata();
    const pad = Math.ceil(Math.max(crop.width, crop.height));
    const padded = await sharp(image)
      .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 1 } })
      .ensureAlpha()
      .raw()
      .toBuffer();
    return sharp(padded, { raw: { width: (meta.width ?? 0) + 2 * pad, height: (meta.height ?? 0) + 2 * pad, channels: 4 } })
      .extract({ left: Math.round(crop.x + pad), top: Math.round(crop.y + pad), width: Math.round(crop.width), height: Math.round(crop.height) })
      .resize(RTMPOSE_WIDTH, RTMPOSE_HEIGHT, { fit: "fill" })
      .raw()
      .toBuffer();
  }

  it("finds the test woman's joints from a rough box, then tracks her from her own pose", async () => {
    ort.env.logLevel = "error";
    ort.env.wasm.numThreads = 1;
    const session = await ort.InferenceSession.create(readFileSync(BODY_FILE));
    const image = readFileSync("tests/fixtures/tryon-woman.jpg");
    const { width = 0, height = 0 } = await sharp(image).metadata();
    const run = async (crop: Box) => {
      const out = await session.run({ input: new ort.Tensor("float32", rtmposeInput(await cropPixels(image, crop)), [1, 3, RTMPOSE_HEIGHT, RTMPOSE_WIDTH]) });
      const x = out.simcc_x?.data;
      const y = out.simcc_y?.data;
      if (!(x instanceof Float32Array) || !(y instanceof Float32Array)) throw new Error("unexpected output");
      return decodeRtmpose(x, y, crop);
    };
    // First frame: nothing known but the whole picture.
    const first = await run(cropFor({ x: 0, y: 0, width, height }));
    const box = poseBox(first);
    expect(box).not.toBeNull();
    if (!box) return;
    const found = await run(cropFor(box));
    const body = ["leftShoulder", "rightShoulder", "leftElbow", "rightElbow", "leftWrist", "rightWrist", "leftHip", "rightHip", "leftKnee", "rightKnee", "leftAnkle", "rightAnkle"] as const;
    for (const name of body) expect(found[name].score).toBeGreaterThan(0.7);
    // Head, shoulders, elbows, hips, knees, ankles from top to bottom; her left on the picture's right.
    const y = (names: readonly (typeof body)[number][]) => names.reduce((s, n) => s + found[n].y, 0) / names.length;
    const order = [found.nose.y, y(["leftShoulder", "rightShoulder"]), y(["leftElbow", "rightElbow"]), y(["leftHip", "rightHip"]), y(["leftKnee", "rightKnee"]), y(["leftAnkle", "rightAnkle"])];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(found.leftShoulder.x).toBeGreaterThan(found.rightShoulder.x);
    expect(found.leftHip.x).toBeGreaterThan(found.rightHip.x);
  }, 30_000);
});
