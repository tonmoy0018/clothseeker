import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import sharp from "sharp";
import { z } from "zod";

import { hairMask } from "@/lib/tryon/hair";
import { visibleHands } from "@/lib/tryon/hands";
import { blendTryOn, tryOnCrop, tryOnMask, type Box } from "@/lib/tryon/mask";
import type { Pose } from "@/lib/vision/models/movenet";
import { maskAtSmooth, SELFIE_SIZE, type PersonMask } from "@/lib/vision/models/segment";

import { AiJobRejected, AiProviderError } from "../errors";
import type { TryOnProvider, TryOnRequest } from "../types";

// Virtual try-on on our own machine (TRYON_PROVIDER=local): no photo leaves it, and there's no shared
// daily GPU allowance. The worker finds the customer's body with the on-device models, masks the area
// the garment goes, and a local CatVTON model (worker/local-tryon/catvton_server.py, a Python process
// kept running between jobs) repaints it. Only the masked area of the result is put back into the
// photo, so the face, hands and background keep their full sharpness.
// Setup: `pnpm tryon:setup` (docs/developers/try-on.md#local-try-on).

/** One try-on for the model process: absolute paths of PNG files in a private temporary folder. */
export type LocalTryOnJob = { person: string; mask: string; garment: string; out: string; steps: number; width: number; height: number; seed: number };

/** Runs try-ons one at a time (CatVtonProcess; a fake in tests). */
export interface LocalTryOnRunner {
  run(job: LocalTryOnJob, signal: AbortSignal): Promise<void>;
  close(): void;
}

/** Finds the body in a photo (NodeVision in the worker). */
export type BodyFinder = {
  analyse(image: Buffer): Promise<{ width: number; height: number; pose: Pose | null }>;
  personMask(image: Buffer): Promise<PersonMask>;
};

export type LocalTryOnOptions = {
  runner: LocalTryOnRunner;
  body: BodyFinder;
  /** Denoising steps: fewer is faster and rougher. */
  steps: number;
  /** The model's picture width (height is 4/3 of it); a multiple of 24. */
  width: number;
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
    // Hair falling over the shoulders stays in front of the new garment.
    const hair = analysis.pose ? hairMask(rgb, width, height, analysis.pose, personAt) : null;
    const keep = hair ? (x: number, y: number) => hair[Math.round(y) * width + Math.round(x)] ?? 0 : undefined;
    // Hands in pockets aren't kept (their spot is the old pocket); visible hands are.
    const hands = analysis.pose ? visibleHands(rgb, width, height, analysis.pose) : undefined;
    const mask = analysis.pose ? tryOnMask(analysis.pose, personAt, width, height, reach, { fit: request.fit, keep, hands }) : null;
    if (!mask) {
      // The photo check refuses these before; a photo that slips through gets the same message.
      throw new AiJobRejected("PHOTO_BODY_NOT_VISIBLE");
    }
    // Cropped around the person, so they fill the model's small picture.
    const box = tryOnCrop(mask, width, height, personBounds(person, width, height));
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
      await this.options.runner.run({ ...job, steps: this.options.steps, width: this.options.width, height: (this.options.width * 4) / 3, seed: 42 }, signal);
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

const replySchema = z.union([
  z.object({ ready: z.literal(true) }).loose(),
  z.object({ id: z.string().nullable(), ok: z.literal(true) }).loose(),
  z.object({ id: z.string().nullable(), ok: z.literal(false), error: z.enum(["OUT_OF_MEMORY", "INVALID_REQUEST", "FAILED"]) }),
]);

/** What the runner uses of the model's child process (a fake in tests). */
export type ModelProcess = {
  stdin: Writable;
  stdout: Readable;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "exit", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
};
export type SpawnModel = (python: string, args: string[], env: Record<string, string>) => ModelProcess;

const defaultSpawn: SpawnModel = (python, args, env) => nodeSpawn(python, args, { env: { ...env, NODE_ENV: process.env.NODE_ENV }, stdio: ["pipe", "pipe", "ignore"] });

export type CatVtonOptions = {
  /** The setup's Python (its virtual environment) and the model folder `pnpm tryon:setup` fills. */
  python: string;
  weights: string;
  script?: string;
  /** Unload the model after this long without a try-on, giving the memory back. */
  idleMs?: number;
  /** Limit for loading the model. */
  loadTimeoutMs?: number;
  spawn?: SpawnModel;
};

/** A try-on waiting for its answer, from the process it was sent to. */
type Pending = { process: ModelProcess; resolve: () => void; reject: (error: Error) => void };

/**
 * The model process: started on the first try-on, kept loaded between jobs, stopped when idle or when a
 * try-on runs out of time (a stuck model can't be interrupted otherwise). Gets only the variables it
 * needs, never the worker's keys. Its stderr is ignored: nothing it prints reaches our logs.
 */
export class CatVtonProcess implements LocalTryOnRunner {
  private child: ModelProcess | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<string, Pending>();
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly spawnModel: SpawnModel;

  constructor(private readonly options: CatVtonOptions) {
    this.spawnModel = options.spawn ?? defaultSpawn;
  }

  run(job: LocalTryOnJob, signal: AbortSignal): Promise<void> {
    const next = this.queue.then(() => this.runNow(job, signal));
    this.queue = next.catch(() => undefined);
    return next;
  }

  close(): void {
    this.stop();
  }

  private async runNow(job: LocalTryOnJob, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new AiProviderError("local try-on aborted", true, "TIMEOUT");
    if (this.idleTimer) clearTimeout(this.idleTimer);
    try {
      const child = await this.start(signal);
      const id = randomUUID();
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          this.stop();
          reject(new AiProviderError("local try-on aborted", true, "TIMEOUT"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        const done = () => signal.removeEventListener("abort", onAbort);
        this.pending.set(id, {
          process: child,
          resolve: () => {
            done();
            resolve();
          },
          reject: (error) => {
            done();
            reject(error);
          },
        });
        child.stdin.write(`${JSON.stringify({ id, ...job })}\n`);
      });
    } finally {
      this.idleTimer = setTimeout(() => this.stop(), this.options.idleMs ?? 600_000);
      this.idleTimer.unref();
    }
  }

  private start(signal: AbortSignal): Promise<ModelProcess> {
    const running = this.child;
    if (running && this.ready) return this.ready.then(() => running);
    const script = this.options.script ?? path.join(process.cwd(), "worker", "local-tryon", "catvton_server.py");
    const child = this.spawnModel(this.options.python, [script, this.options.weights], {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      PYTHONNOUSERSITE: "1",
      PYTHONUNBUFFERED: "1",
      // Never reach the network: everything was downloaded and checked by the setup.
      HF_HUB_OFFLINE: "1",
      // Caps what the Mac's GPU may hold (of its memory), so a try-on can't push the machine into swap.
      PYTORCH_MPS_HIGH_WATERMARK_RATIO: "0.55",
      PYTORCH_MPS_LOW_WATERMARK_RATIO: "0.45",
    });
    this.child = child;
    // Writing to a process that just died fails here; its "exit" reports it.
    child.stdin.on("error", () => undefined);
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stop();
        reject(new AiProviderError("local try-on model took too long to load", true, "TIMEOUT"));
      }, this.options.loadTimeoutMs ?? 300_000);
      const onAbort = () => {
        clearTimeout(timer);
        this.stop();
        reject(new AiProviderError("local try-on aborted", true, "TIMEOUT"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      createInterface({ input: child.stdout }).on("line", (line) => {
        const reply = parseReply(line);
        if (!reply) return;
        if ("ready" in reply) {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve();
          return;
        }
        const waiting = reply.id ? this.pending.get(reply.id) : undefined;
        if (!waiting || !reply.id) return;
        this.pending.delete(reply.id);
        if (reply.ok) waiting.resolve();
        else waiting.reject(new AiProviderError(`local try-on failed (${reply.error})`, reply.error !== "INVALID_REQUEST"));
      });
      child.once("exit", () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (this.child === child) {
          this.child = null;
          this.ready = null;
        }
        const stopped = new AiProviderError("local try-on model stopped", true);
        reject(stopped);
        // Only this process's try-ons: a killed process may exit after its replacement has started.
        for (const [id, waiting] of this.pending) {
          if (waiting.process !== child) continue;
          this.pending.delete(id);
          waiting.reject(stopped);
        }
      });
      child.once("error", () => {
        // The Python couldn't be started (setup missing): "exit" may not follow.
        clearTimeout(timer);
        this.child = null;
        this.ready = null;
        reject(new AiProviderError("local try-on model couldn't start", true));
      });
    });
    return this.ready.then(() => child);
  }

  private stop(): void {
    const child = this.child;
    this.child = null;
    this.ready = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    child?.kill("SIGKILL");
  }
}

function parseReply(line: string): z.infer<typeof replySchema> | null {
  try {
    const parsed = replySchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
