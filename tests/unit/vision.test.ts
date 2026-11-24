import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { modelPath, ORT_VERSION, VISION_MODELS } from "@/lib/vision/runtime/assets";
import { fitRect, fitSquare, letterboxRgba, toSource } from "@/lib/vision/models/geometry";
import { decodeMovenet, MOVENET_SIZE, movenetInput } from "@/lib/vision/models/movenet";
import { isFromWorker, isToWorker } from "@/lib/vision/runtime/protocol";
import { maskAt, matteInput, matteSize, SELFIE_SIZE, selfieInput } from "@/lib/vision/models/segment";
import { OneEuro, PoseSmoother } from "@/lib/vision/mirror/smooth";
import { decodeYunet, YUNET_SIZE, yunetInput } from "@/lib/vision/models/yunet";

// The pure parts of on-device vision: letterboxing, model inputs, decoding and smoothing. The models
// themselves were checked on real photos when they were chosen (docs/developers/live-try-on.md).

describe("letterboxing", () => {
  it("fits portrait and landscape frames without distortion and maps points back", () => {
    const portrait = fitSquare(768, 1024, 192);
    expect(portrait).toMatchObject({ size: 192, scale: 0.1875, width: 144, height: 192, offsetX: 24, offsetY: 0 });
    expect(toSource(portrait, 24 + 72, 96)).toEqual([384, 512]);
    const landscape = fitSquare(1280, 720, 256);
    expect(landscape).toMatchObject({ width: 256, height: 144, offsetX: 0, offsetY: 56 });
    const [x, y] = toSource(landscape, 128, 56 + 72);
    expect([x, y]).toEqual([640, 360]);
  });

  it("pads with black and keeps the picture's pixels", () => {
    const source = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]); // 2×1: red, green
    const box = fitSquare(2, 1, 4);
    const out = letterboxRgba(source, 2, 1, box);
    const pixel = (x: number, y: number) => Array.from(out.slice((y * 4 + x) * 4, (y * 4 + x) * 4 + 4));
    expect(pixel(0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(0, 1)).toEqual([255, 0, 0, 255]);
    expect(pixel(3, 2)).toEqual([0, 255, 0, 255]);
  });
});

describe("model inputs", () => {
  const rgba = (size: number) => {
    const data = new Uint8ClampedArray(size * size * 4);
    data.set([10, 20, 30, 255], 0);
    return data;
  };

  it("MoveNet takes interleaved RGB integers", () => {
    expect(Array.from(movenetInput(rgba(MOVENET_SIZE)).slice(0, 3))).toEqual([10, 20, 30]);
  });

  it("YuNet takes planar BGR, unscaled", () => {
    const input = yunetInput(rgba(YUNET_SIZE));
    const plane = YUNET_SIZE * YUNET_SIZE;
    expect([input[0], input[plane], input[plane * 2]]).toEqual([30, 20, 10]);
  });

  it("the outline model takes planar RGB scaled to 0–1", () => {
    const input = selfieInput(rgba(SELFIE_SIZE));
    const plane = SELFIE_SIZE * SELFIE_SIZE;
    expect(input[0]).toBeCloseTo(10 / 255);
    expect(input[plane * 2]).toBeCloseTo(30 / 255);
  });
});

describe("decoding", () => {
  it("MoveNet keypoints come back in frame pixels, the person's own left and right", () => {
    const box = fitSquare(768, 1024, MOVENET_SIZE);
    const output = new Float32Array(17 * 3);
    output.set([0.5, 0.5, 0.9], 0); // nose at the centre of the square
    output.set([0.25, 0.6, 0.8], 5 * 3); // left shoulder
    const pose = decodeMovenet(output, box);
    expect(pose.nose).toEqual({ x: 384, y: 512, score: expect.closeTo(0.9, 5) });
    expect(pose.leftShoulder.x).toBeCloseTo((0.6 * 192 - 24) / 0.1875);
    expect(pose.leftShoulder.y).toBeCloseTo(256);
    expect(pose.rightAnkle.score).toBe(0);
  });

  it("YuNet faces: grid cell plus offsets, best first, duplicates removed, weak ones ignored", () => {
    const box = fitSquare(640, 640, YUNET_SIZE);
    const outputs: Record<string, Float32Array> = {};
    for (const stride of [8, 16, 32]) {
      const cells = (YUNET_SIZE / stride) ** 2;
      outputs[`cls_${stride}`] = new Float32Array(cells);
      outputs[`obj_${stride}`] = new Float32Array(cells);
      outputs[`bbox_${stride}`] = new Float32Array(cells * 4);
      outputs[`kps_${stride}`] = new Float32Array(cells * 10);
    }
    const put = (stride: number, col: number, row: number, score: number) => {
      const i = row * (YUNET_SIZE / stride) + col;
      outputs[`cls_${stride}`]?.set([score], i);
      outputs[`obj_${stride}`]?.set([score], i);
      outputs[`bbox_${stride}`]?.set([0.5, 0.5, Math.log(4), Math.log(5)], i * 4);
      outputs[`kps_${stride}`]?.set([0.25, 0.25, 0.75, 0.25, 0.5, 0.5, 0.3, 0.75, 0.7, 0.75], i * 10);
    };
    put(16, 10, 6, 0.95); // centre (168, 104), 64 × 80
    put(16, 11, 6, 0.9); // the same face from the next cell (overlap 0.6): removed as a duplicate
    put(32, 2, 2, 0.4); // too weak
    const faces = decodeYunet(outputs, box);
    expect(faces).toHaveLength(1);
    expect(faces[0]).toMatchObject({ x: expect.closeTo(136, 3), y: expect.closeTo(64, 3), width: expect.closeTo(64, 3), height: expect.closeTo(80, 3), score: expect.closeTo(0.95, 5) });
    expect(faces[0]?.landmarks[2]?.map((v) => Math.round(v))).toEqual([168, 104]);
  });

  it("reads the person mask at frame coordinates", () => {
    const box = fitSquare(512, 256, SELFIE_SIZE); // scale 0.5, offsetY 64
    const alpha = new Float32Array(SELFIE_SIZE * SELFIE_SIZE);
    alpha[(64 + 10) * SELFIE_SIZE + 50] = 0.8;
    const mask = { alpha, width: SELFIE_SIZE, height: SELFIE_SIZE, box };
    expect(maskAt(mask, 100, 20)).toBeCloseTo(0.8);
    expect(maskAt(mask, -5, 20)).toBe(0);
  });

  it("fits the matting model to the frame's own shape and reads its outline back at frame coordinates", () => {
    // A 16:9 camera: 384 × 224 (multiples of 32), the frame letterboxed with 4 px above and below.
    expect(matteSize(1280, 720)).toEqual({ width: 384, height: 224 });
    expect(matteSize(720, 1280)).toEqual({ width: 224, height: 384 });
    const box = fitRect(1280, 720, 384, 224);
    expect(box).toMatchObject({ scale: 0.3, offsetX: 0, offsetY: 4, width: 384, height: 216 });
    const alpha = new Float32Array(384 * 224);
    alpha[(4 + 30) * 384 + 60] = 0.9;
    const mask = { alpha, width: 384, height: 224, box };
    expect(maskAt(mask, 200, 100)).toBeCloseTo(0.9);
    expect(maskAt(mask, 200, 2000)).toBe(0);
    // Its input: RGB planes scaled to −1…1.
    const input = matteInput(Uint8ClampedArray.from([255, 0, 127.5, 255]), 1, 1);
    expect(Array.from(input).map((v) => Math.round(v * 100) / 100)).toEqual([1, -1, 0]);
  });
});

describe("smoothing", () => {
  it("steadies jitter when still and follows a real movement", () => {
    const filter = new OneEuro();
    const jitter = [100, 103, 97, 102, 98, 101, 99, 103, 97, 100].map((v, i) => filter.next(v, i * 33));
    const spread = (values: number[]) => Math.max(...values.slice(3)) - Math.min(...values.slice(3));
    expect(spread(jitter)).toBeLessThan(3);
    let value = 0;
    for (let i = 0; i < 15; i += 1) value = filter.next(300, 330 + i * 33);
    expect(value).toBeGreaterThan(280);
  });

  it("smooths each keypoint and restarts points it lost", () => {
    const smoother = new PoseSmoother(["a", "b"] as const);
    smoother.next({ a: { x: 0, y: 0, score: 1 }, b: { x: 50, y: 50, score: 1 } }, 0);
    const next = smoother.next({ a: { x: 10, y: 0, score: 1 }, b: { x: 500, y: 500, score: 0.05 } }, 33);
    expect(next.a.x).toBeGreaterThan(0);
    expect(next.a.x).toBeLessThan(10);
    expect(next.b.x).toBe(500);
  });
});

describe("assets and messages", () => {
  it("serves each model under its hash and pins the installed runtime", () => {
    for (const model of Object.values(VISION_MODELS)) {
      expect(modelPath(model)).toBe(`/vision/models/${model.id}-${model.sha256.slice(0, 12)}.onnx`);
      expect(model.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const pkg: unknown = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg).toMatchObject({ dependencies: { "onnxruntime-web": ORT_VERSION } });
  });

  it("only accepts well-formed worker messages", () => {
    expect(isToWorker({ type: "init", models: ["pose"] })).toBe(true);
    expect(isToWorker({ type: "analyse", id: 1, frame: "not a bitmap", request: {} })).toBe(false);
    expect(isFromWorker({ type: "ready", backend: "webgpu" })).toBe(true);
    expect(isFromWorker({ type: "ready", backend: "cuda" })).toBe(false);
    expect(isFromWorker({ type: "error", id: 3, message: "x" })).toBe(true);
    expect(isFromWorker("ready")).toBe(false);
  });
});
