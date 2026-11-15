import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";

import { hairMask } from "@/lib/tryon/hair";
import { visibleHands } from "@/lib/tryon/hands";
import { blendTryOn, tryOnCrop, tryOnMask, type Box } from "@/lib/tryon/mask";
import { hairFromParts, handsFromParts } from "@/lib/tryon/parts";
import type { Pose } from "@/lib/vision/models/movenet";
import type { BodyParts } from "@/lib/vision/models/parts";
import { maskAtSmooth, SELFIE_SIZE, type PersonMask } from "@/lib/vision/models/segment";

import { AiJobRejected, AiProviderError } from "../errors";
import type { TryOnProvider, TryOnRequest } from "../types";
import type { ModelSlot } from "./model-slot";
import { PythonModelProcess, type SpawnModel } from "./python-model";

export type { ModelProcess, SpawnModel } from "./python-model";

// Virtual try-on on our own machine (TRYON_PROVIDER=local): no photo leaves it, and there's no shared
// daily GPU allowance. The worker finds the customer's body with the on-device models, masks the area
// the garment goes, and a local CatVTON model (worker/local-tryon/catvton_server.py, a Python process
// kept running between jobs) repaints it. Only the masked area of the result is put back into the
// photo, so the face, hands and background keep their full sharpness.
// Setup: `pnpm tryon:setup` (docs/developers/try-on.md#local-try-on).

/**
 * How the model works through its steps. "lcm" adds few-step weights and finishes in 8; "unipc" needs
 * about 20, "ddim" 30 or more.
 */
export type LocalTryOnSampler = "lcm" | "unipc" | "ddim";

/** How strongly the garment is followed (classifier-free guidance): what each sampler was tuned with. */
const GUIDANCE: Record<LocalTryOnSampler, number> = { lcm: 2, unipc: 2.5, ddim: 2.5 };

/** One try-on for the model process: absolute paths of PNG files in a private temporary folder. */
export type LocalTryOnJob = {
  person: string;
  mask: string;
  garment: string;
  out: string;
  steps: number;
  width: number;
  height: number;
  seed: number;
  sampler: LocalTryOnSampler;
  guidance: number;
  /** The share of the steps (first ones) that also run without the garment, to compare: 1 = all of them. */
  guided: number;
};

/** Runs try-ons one at a time (CatVtonProcess; a fake in tests). */
export interface LocalTryOnRunner {
  run(job: LocalTryOnJob, signal: AbortSignal): Promise<void>;
  close(): void;
}

/** Finds the body in a photo (NodeVision in the worker). */
export type BodyFinder = {
  analyse(image: Buffer): Promise<{ width: number; height: number; pose: Pose | null }>;
  personMask(image: Buffer): Promise<PersonMask>;
  /** What each pixel of a box around the person is (hair, skin, clothes…); without it, hair and hands are told by colour. */
  bodyParts?(image: Buffer, region: Box): Promise<BodyParts>;
};

export type LocalTryOnOptions = {
  runner: LocalTryOnRunner;
  body: BodyFinder;
  /** Denoising steps: fewer is faster and rougher. */
  steps: number;
  /** The model's picture width (height is 4/3 of it); a multiple of 24. */
  width: number;
  sampler: LocalTryOnSampler;
  /** The share of the steps that compare with and without the garment (0–1]; the rest only sharpen, at half the cost. */
  guided: number;
};

export class LocalTryOn implements TryOnProvider {
  readonly name = "local";

  constructor(private readonly options: LocalTryOnOptions) {}

  close(): void {
    this.options.runner.close();
  }

  async tryOn(request: TryOnRequest, signal: AbortSignal): Promise<Buffer> {
    const { data: rgb, info } = await sharp(request.person.data).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height } = info;
    const [analysis, person] = await Promise.all([this.options.body.analyse(request.person.data), this.options.body.personMask(request.person.data)]);
    const reach = request.reach ?? (request.category === "Dress" ? "ankles" : "hips");
    const personAt = (x: number, y: number) => maskAtSmooth(person, x, y);
    const bounds = personBounds(person, width, height);
    const pose = analysis.pose;
    if (!pose) {
      // The photo check refuses these before; a photo that slips through gets the same message.
      throw new AiJobRejected("PHOTO_BODY_NOT_VISIBLE");
    }
    // What's hair, skin and clothes, read around the person (the model expects them to fill its picture).
    // If it can't be read, hair and hands are told by colour, as before the model was added.
    const parts = await this.options.body.bodyParts?.(request.person.data, partsRegion(bounds, width, height)).catch(() => null);
    let keep: ((x: number, y: number) => number) | undefined;
    let hands: { left: boolean; right: boolean };
    if (parts) {
      keep = hairFromParts(parts, pose) ?? undefined;
      hands = handsFromParts(parts, pose);
    } else {
      const hair = hairMask(rgb, width, height, pose, personAt);
      keep = hair ? (x, y) => hair[Math.round(y) * width + Math.round(x)] ?? 0 : undefined;
      hands = visibleHands(rgb, width, height, pose);
    }
    // Hair stays in front of the new garment. Hands in pockets aren't kept (their spot is the old pocket); visible hands are.
    const mask = tryOnMask(pose, personAt, width, height, reach, { fit: request.fit, keep, hands });
    if (!mask) {
      throw new AiJobRejected("PHOTO_BODY_NOT_VISIBLE");
    }
    // Cropped around the person, so they fill the model's small picture.
    const box = tryOnCrop(mask, width, height, bounds);
    const crop = (data: Uint8Array, channels: 1 | 3) => sharp(data, { raw: { width, height, channels } }).extract(box);

    const dir = await mkdtemp(path.join(tmpdir(), "clothseeker-tryon-"));
    try {
      const file = (name: string) => path.join(dir, name);
      await Promise.all([
        crop(rgb, 3).png().toFile(file("person.png")),
        crop(mask, 1).png().toFile(file("mask.png")),
        fittedGarment(request.garment.data, request.fit?.width ?? 1).then((garment) => sharp(garment).toFile(file("garment.png"))),
      ]);
      const job = { person: file("person.png"), mask: file("mask.png"), garment: file("garment.png"), out: file("result.png") };
      const { steps, width: modelWidth, sampler, guided } = this.options;
      await this.options.runner.run({ ...job, steps, width: modelWidth, height: (modelWidth * 4) / 3, seed: 42, sampler, guidance: GUIDANCE[sampler], guided }, signal);
      const result = await readFile(job.out).catch(() => null);
      if (!result) {
        throw new AiProviderError("local try-on wrote no picture", true);
      }
      return await putBack(rgb, width, height, box, mask, result);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** The person's box in the photo, from the person outline (letterbox space → photo pixels), or null. */
function personBounds(person: PersonMask, width: number, height: number): Box | null {
  const { box } = person;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < SELFIE_SIZE; y += 1) {
    for (let x = 0; x < SELFIE_SIZE; x += 1) {
      if ((person.alpha[y * SELFIE_SIZE + x] ?? 0) < 0.5) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x + 1);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y + 1);
    }
  }
  if (minX === Infinity) return null;
  const left = Math.max(0, Math.floor((minX - box.offsetX) / box.scale));
  const top = Math.max(0, Math.floor((minY - box.offsetY) / box.scale));
  const right = Math.min(width, Math.ceil((maxX - box.offsetX) / box.scale));
  const bottom = Math.min(height, Math.ceil((maxY - box.offsetY) / box.scale));
  return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
}

/** The box the body-parts model reads: the person with a little room around, or the whole photo. */
function partsRegion(bounds: Box | null, width: number, height: number): Box {
  if (!bounds) return { left: 0, top: 0, width, height };
  const room = Math.round(0.06 * Math.max(bounds.width, bounds.height));
  const left = Math.max(0, bounds.left - room);
  const top = Math.max(0, bounds.top - room);
  return { left, top, width: Math.min(width, bounds.left + bounds.width + room) - left, height: Math.min(height, bounds.top + bounds.height + room) - top };
}

/**
 * The garment picture, widened (a size too big) or narrowed (too small) about its centre on the same
 * white canvas: the model draws a wider garment looser on the body, a narrower one snug.
 */
async function fittedGarment(garment: Buffer, widthScale: number): Promise<Buffer> {
  const flat = sharp(garment).flatten({ background: "#ffffff" });
  if (Math.abs(widthScale - 1) < 0.01) return flat.png().toBuffer();
  const { data, info } = await flat.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const scaled = Math.max(1, Math.round(info.width * widthScale));
  const resized = await sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } }).resize(scaled, info.height, { fit: "fill" }).png().toBuffer();
  // Centred on the original canvas; anything wider than it is trimmed equally from both sides.
  const left = Math.round((info.width - scaled) / 2);
  const piece = left >= 0 ? resized : await sharp(resized).extract({ left: -left, top: 0, width: info.width, height: info.height }).png().toBuffer();
  return sharp({ create: { width: info.width, height: info.height, channels: 3, background: "#ffffff" } })
    .composite([{ input: piece, left: Math.max(0, left), top: 0 }])
    .png()
    .toBuffer();
}

/** The model's picture, scaled to the crop, blended into the photo inside the softened mask. */
async function putBack(rgb: Buffer, width: number, height: number, box: Box, mask: Uint8Array, result: Buffer): Promise<Buffer> {
  const model = await sharp(result).resize(box.width, box.height, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const feather = await sharp(mask, { raw: { width, height, channels: 1 } })
    .extract(box)
    .blur(Math.max(1, box.width / 200))
    .extractChannel(0)
    .raw()
    .toBuffer();
  const photo = await sharp(rgb, { raw: { width, height, channels: 3 } }).extract(box).raw().toBuffer();
  blendTryOn(photo, model, feather);
  return sharp(rgb, { raw: { width, height, channels: 3 } })
    .composite([{ input: photo, raw: { width: box.width, height: box.height, channels: 3 }, left: box.left, top: box.top }])
    .png()
    .toBuffer();
}

export type CatVtonOptions = {
  /** The setup's Python (its virtual environment) and the model folder `pnpm tryon:setup` fills. */
  python: string;
  weights: string;
  script?: string;
  idleMs?: number;
  loadTimeoutMs?: number;
  slot?: ModelSlot;
  spawn?: SpawnModel;
};

/** The CatVTON process (worker/local-tryon/catvton_server.py). */
export class CatVtonProcess extends PythonModelProcess<LocalTryOnJob> implements LocalTryOnRunner {
  constructor({ python, weights, script, ...rest }: CatVtonOptions) {
    super({
      ...rest,
      python,
      script: script ?? path.join(process.cwd(), "worker", "local-tryon", "catvton_server.py"),
      args: [weights],
      label: "local try-on",
      // Caps what the Mac's GPU may hold (of its memory), so a try-on can't push the machine into swap.
      env: { PYTORCH_MPS_HIGH_WATERMARK_RATIO: "0.55", PYTORCH_MPS_LOW_WATERMARK_RATIO: "0.45" },
    });
  }
}
