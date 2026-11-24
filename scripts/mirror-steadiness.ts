import { readFile } from "node:fs/promises";
import path from "node:path";

import * as ort from "onnxruntime-web";
import sharp from "sharp";

import { modelPath, VISION_MODELS } from "@/lib/vision/runtime/assets";
import { fitSquare } from "@/lib/vision/models/geometry";
import { BodyTracker, decodeRtmpose, maskBox, RTMPOSE_HEIGHT, RTMPOSE_WIDTH, rtmposeInput, type Box } from "@/lib/vision/models/rtmpose";
import { SELFIE_SIZE, selfieInput, type PersonMask } from "@/lib/vision/models/segment";
import type { Pose } from "@/lib/vision/models/movenet";
import { bodySmoother } from "@/lib/vision/mirror/smooth";
import { ClothSway, WidthSmoother } from "@/lib/vision/mirror/cloth";
import { recoverGarment } from "@/lib/vision/mirror/garment-fill";
import { bodyAnchors, fitToOutline, garmentFit, garmentMesh, maskBounds, measureOutline, type GarmentFit, type Point } from "@/lib/vision/mirror/mirror";
import { findGarment, splitGarment } from "@/lib/garment-photo/segment";
import { maskAtSmooth } from "@/lib/vision/models/segment";

// How steady the live mirror's body is: plays the fake-camera person (tests/fixtures/mirror-woman.mjpeg)
// as a webcam would (fresh sensor noise each frame, standing still, then stepping sideways, then still)
// through the real models and the mirror's tracking and smoothing, and reports how much the anchors the
// garment hangs from move while the person doesn't (% of the shoulder width) and how far they lag a move.
//
//   pnpm exec tsx scripts/mirror-steadiness.ts

ort.env.logLevel = "error";
ort.env.wasm.numThreads = 1;

const FPS = 15;
const FRAMES = 210;
/** Frames of the sideways step, and its speed (camera pixels a frame). */
const MOVE_FROM = 90;
const MOVE_TO = 135;
const MOVE_PX = 5;
/** A dim room's webcam (`HARSH=1`): more sensor noise, auto-exposure flicker and JPEG compression. */const HARSH = process.env.HARSH === "1";
const NOISE = HARSH ? 7 : 3;

function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const shiftAt = (t: number) => MOVE_PX * Math.min(MOVE_TO - MOVE_FROM, Math.max(0, t - MOVE_FROM));

type Frame = { rgba: Uint8ClampedArray; width: number; height: number };

async function frameAt(base: Frame, t: number, random: () => number): Promise<Frame> {
  const { width, height } = base;
  const out = new Uint8ClampedArray(width * height * 4);
  const dx = shiftAt(t);
  const gain = HARSH ? 1 + (random() - 0.5) * 0.08 : 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(width - 1, Math.max(0, x - dx));
      const s = (y * width + sx) * 4;
      const d = (y * width + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        const u = Math.max(1e-9, random());
        const gauss = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
        out[d + c] = (base.rgba[s + c] ?? 0) * gain + gauss * NOISE;
      }
      out[d + 3] = 255;
    }
  }
  if (!HARSH) return { rgba: out, width, height };
  const jpeg = await sharp(Buffer.from(out.buffer), { raw: { width, height, channels: 4 } }).jpeg({ quality: 70 }).toBuffer();
  const decoded = await sharp(jpeg).ensureAlpha().raw().toBuffer();
  return { rgba: new Uint8ClampedArray(decoded), width, height };
}

/** Bilinear sample of `box` into a w×h RGBA picture (black outside the frame), as a canvas drawImage does. */
function sampleBox(frame: Frame, box: Box, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const sx = box.x + ((x + 0.5) / w) * box.width - 0.5;
      const sy = box.y + ((y + 0.5) / h) * box.height - 0.5;
      const fx = Math.floor(sx);
      const fy = Math.floor(sy);
      const tx = sx - fx;
      const ty = sy - fy;
      const d = (y * w + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        const at = (px: number, py: number) => (px < 0 || py < 0 || px >= frame.width || py >= frame.height ? 0 : (frame.rgba[(py * frame.width + px) * 4 + c] ?? 0));
        out[d + c] = (at(fx, fy) * (1 - tx) + at(fx + 1, fy) * tx) * (1 - ty) + (at(fx, fy + 1) * (1 - tx) + at(fx + 1, fy + 1) * tx) * ty;
      }
      out[d + 3] = 255;
    }
  }
  return out;
}

async function personMask(session: ort.InferenceSession, frame: Frame): Promise<PersonMask> {
  const box = fitSquare(frame.width, frame.height, SELFIE_SIZE);
  const rgba = await sharp(Buffer.from(frame.rgba.buffer), { raw: { width: frame.width, height: frame.height, channels: 4 } })
    .resize(box.width, box.height, { fit: "fill" })
    .extend({ top: box.offsetY, left: box.offsetX, bottom: SELFIE_SIZE - box.height - box.offsetY, right: SELFIE_SIZE - box.width - box.offsetX, background: { r: 0, g: 0, b: 0, alpha: 1 } })
    .raw()
    .toBuffer();
  const out = await session.run({ pixel_values: new ort.Tensor("float32", selfieInput(rgba), [1, 3, SELFIE_SIZE, SELFIE_SIZE]) });
  if (!(out.alphas?.data instanceof Float32Array)) throw new Error("mask output");
  return { alpha: out.alphas.data, width: SELFIE_SIZE, height: SELFIE_SIZE, box };
}

type Step = { t: number; raw: Pose; pose: Pose; sway: Point; mesh: Point[] | null };

/** A catalogue photo cut out and measured as the live mirror does (garment-source.ts, without the body-parts model). */
async function garment(slug: string): Promise<GarmentFit> {
  const { data, info } = await sharp(path.join(process.cwd(), "prisma", "seed-photos", `${slug}.jpg`)).resize({ width: 600 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixels = { data: new Uint8Array(data), width: info.width, height: info.height };
  const found = findGarment(pixels);
  const parts = splitGarment(found);
  return garmentFit({ ...parts, garment: recoverGarment(pixels, found, maskBounds(found).bottom) });
}

async function main() {
  const fixture = await readFile(path.join(process.cwd(), "tests", "fixtures", "mirror-woman.mjpeg"));
  const end = fixture.indexOf(Buffer.from([0xff, 0xd8, 0xff]), 3);
  const { data, info } = await sharp(end > 0 ? fixture.subarray(0, end) : fixture).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const base: Frame = { rgba: new Uint8ClampedArray(data), width: info.width, height: info.height };
  const load = async (id: "body" | "mask") => ort.InferenceSession.create(await readFile(path.join(process.cwd(), "public", modelPath(VISION_MODELS[id]))));
  const [body, mask] = [await load("body"), await load("mask")];
  const fit = await garment(process.argv[2] ?? "floral-sundress");

  const random = rng(7);
  const frames: Frame[] = [];
  const outlines: (PersonMask | null)[] = [];
  for (let t = 0; t < FRAMES; t += 1) {
    const frame = await frameAt(base, t, random);
    frames.push(frame);
    outlines.push(t % 2 === 0 ? await personMask(mask, frame) : null);
  }
  console.log(`frame ${base.width}×${base.height}, ${FRAMES} frames at ${FPS} fps, noise σ=${NOISE}${HARSH ? ", exposure flicker, JPEG 70" : ""}, step ${MOVE_PX * (MOVE_TO - MOVE_FROM)} px`);

  const tracker = new BodyTracker();
  const smoother = bodySmoother();
  const sway = new ClothSway();
  const widthSmoother = new WidthSmoother();
  let person: PersonMask | null = null;
  let maskCentre: Point | null = null;
  const series: Step[] = [];
  for (let t = 0; t < FRAMES; t += 1) {
    const frame = frames[t];
    if (!frame) continue;
    const outline = outlines[t];
    const crop = tracker.next(frame.width, frame.height, outline ? maskBox(outline) : null);
    const input = rtmposeInput(sampleBox(frame, crop, RTMPOSE_WIDTH, RTMPOSE_HEIGHT));
    const out = await body.run({ input: new ort.Tensor("float32", input, [1, 3, RTMPOSE_HEIGHT, RTMPOSE_WIDTH]) });
    if (!(out.simcc_x?.data instanceof Float32Array) || !(out.simcc_y?.data instanceof Float32Array)) throw new Error("body output");
    const raw = decodeRtmpose(out.simcc_x.data, out.simcc_y.data, crop);
    tracker.found(raw);
    const time = (t * 1000) / FPS;
    const pose = smoother.next(raw, time);
    const anchors = bodyAnchors(pose);
    if (outline) {
      person = outline;
      maskCentre = null;
    }
    if (!anchors) {
      series.push({ t, raw, pose, sway: { x: 0, y: 0 }, mesh: null });
      continue;
    }
    // As the live mirror's loop does (live-mirror.tsx).
    const span = Math.hypot(anchors.leftShoulder.x - anchors.rightShoulder.x, anchors.leftShoulder.y - anchors.rightShoulder.y);
    const centre = { x: (raw.leftShoulder.x + raw.rightShoulder.x + raw.leftHip.x + raw.rightHip.x) / 4, y: (raw.leftShoulder.y + raw.rightShoulder.y + raw.leftHip.y + raw.rightHip.y) / 4 };
    maskCentre ??= centre;
    const shift = { x: centre.x - maskCentre.x, y: centre.y - maskCentre.y };
    const seen = person;
    const widths = seen ? widthSmoother.next(fitToOutline(fit, anchors, measureOutline(fit, anchors, (x, y) => maskAtSmooth(seen, x - shift.x, y - shift.y)))) : null;
    const offset = sway.next({ x: (anchors.leftHip.x + anchors.rightHip.x) / 2, y: (anchors.leftHip.y + anchors.rightHip.y) / 2 }, span, time);
    const mesh = garmentMesh(fit, anchors, undefined, undefined, { widths, sway: offset }).flatMap((tri) => tri.dst);
    series.push({ t, raw, pose, sway: offset, mesh });
  }
  report(series);
}

function report(series: Step[]) {
  const still = series.filter((s) => (s.t >= 20 && s.t < MOVE_FROM) || s.t >= MOVE_TO + 25);
  const span = (p: Pose) => Math.hypot(p.leftShoulder.x - p.rightShoulder.x, p.leftShoulder.y - p.rightShoulder.y);
  const shoulders = still.reduce((sum, s) => sum + span(s.raw), 0) / Math.max(1, still.length);
  const pct = (px: number) => `${((100 * px) / shoulders).toFixed(2)}%`;
  // Frame-to-frame movement while the person stands still: what the eye sees as wiggling.
  const steps = (key: "raw" | "pose", joints: readonly (keyof Pose)[]) => {
    let sum = 0;
    let n = 0;
    for (let i = 1; i < still.length; i += 1) {
      const a = still[i - 1];
      const b = still[i];
      if (!a || !b || b.t !== a.t + 1) continue;
      for (const j of joints) {
        sum += Math.hypot(b[key][j].x - a[key][j].x, b[key][j].y - a[key][j].y) ** 2;
        n += 1;
      }
    }
    return Math.sqrt(sum / Math.max(1, n));
  };
  // How far behind the (known) step the smoothed shoulders and hips are while moving and just after.
  const restAt = (j: keyof Pose) => {
    const before = still.filter((s) => s.t < MOVE_FROM);
    return { x: before.reduce((sum, s) => sum + s.raw[j].x, 0) / before.length, y: before.reduce((sum, s) => sum + s.raw[j].y, 0) / before.length };
  };
  let lag = 0;
  let lagN = 0;
  for (const s of series.filter((s) => s.t >= MOVE_FROM && s.t < MOVE_TO + 10)) {
    for (const j of ["leftShoulder", "rightShoulder", "leftHip", "rightHip"] as const) {
      lag += Math.abs(s.pose[j].x - (restAt(j).x + shiftAt(s.t)));
      lagN += 1;
    }
  }
  // The hem after the step: how far it swings past (opposite the move) and how long until it's still.
  const after = series.filter((s) => s.t >= MOVE_TO);
  const overshoot = Math.max(0, ...after.map((s) => s.sway.x));
  const lastLarge = after.filter((s) => Math.abs(s.sway.x) > shoulders * 0.01).at(-1);
  const settle = lastLarge ? ((lastLarge.t - MOVE_TO) / FPS).toFixed(1) : "0";
  const swayStill = Math.sqrt(still.reduce((sum, s) => sum + s.sway.x ** 2 + s.sway.y ** 2, 0) / Math.max(1, still.length));
  // The garment itself: how far its mesh corners move from frame to frame (mean, and the worst 5%).
  const meshSteps: number[] = [];
  for (let i = 1; i < still.length; i += 1) {
    const a = still[i - 1];
    const b = still[i];
    if (!a?.mesh || !b?.mesh || b.t !== a.t + 1) continue;
    b.mesh.forEach((p, k) => {
      const q = a.mesh?.[k];
      if (q) meshSteps.push(Math.hypot(p.x - q.x, p.y - q.y));
    });
  }
  meshSteps.sort((x, y) => x - y);
  const meshMean = meshSteps.reduce((sum, v) => sum + v, 0) / Math.max(1, meshSteps.length);
  const meshP95 = meshSteps[Math.floor(meshSteps.length * 0.95)] ?? 0;
  const torso = ["leftShoulder", "rightShoulder", "leftHip", "rightHip"] as const;
  const limbs = ["leftElbow", "rightElbow", "leftWrist", "rightWrist"] as const;
  console.log(
    [
      `raw torso ${pct(steps("raw", torso))}`,
      `torso ${pct(steps("pose", torso))}`,
      `arms ${pct(steps("pose", limbs))}`,
      `hem ${pct(swayStill)}`,
      `garment ${pct(meshMean)} (worst ${pct(meshP95)})`,
      `lag ${pct(lag / Math.max(1, lagN))}`,
      `swings past ${pct(overshoot)}, settles in ${settle} s`,
    ].join("  "),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
