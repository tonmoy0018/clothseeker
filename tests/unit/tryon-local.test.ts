import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { AiJobRejected, AiProviderError } from "@/lib/ai/errors";
import { CatVtonProcess, LocalTryOn, type LocalTryOnJob, type LocalTryOnRunner, type ModelProcess } from "@/lib/ai/tryon-local";
import { localTryOnPaths, localTryOnReady } from "@/lib/ai/tryon-local-setup";
import type { Keypoint, Pose } from "@/lib/vision/movenet";
import { SELFIE_SIZE } from "@/lib/vision/segment";
import { fitSquare } from "@/lib/vision/geometry";

// The local try-on: the customer's body is masked on our machine, a local model repaints that area,
// and only the masked area is put back into the photo. The model process itself is faked here.

const W = 600;
const H = 800;
const at = (x: number, y: number): Keypoint => ({ x, y, score: 0.9 });
const POSE: Pose = {
  nose: at(300, 110),
  leftEye: at(310, 100),
  rightEye: at(290, 100),
  leftEar: at(320, 105),
  rightEar: at(280, 105),
  leftShoulder: at(360, 200),
  rightShoulder: at(240, 200),
  leftElbow: at(375, 320),
  rightElbow: at(225, 320),
  leftWrist: at(380, 430),
  rightWrist: at(220, 430),
  leftHip: at(340, 430),
  rightHip: at(260, 430),
  leftKnee: at(340, 590),
  rightKnee: at(260, 590),
  leftAnkle: at(340, 740),
  rightAnkle: at(260, 740),
};

const body = (pose: Pose | null) => ({
  analyse: async () => ({ width: W, height: H, pose }),
  personMask: async () => ({ alpha: new Float32Array(SELFIE_SIZE * SELFIE_SIZE), box: fitSquare(W, H, SELFIE_SIZE) }),
});

/** A model that paints everything red, recording what it was given. */
class RedRunner implements LocalTryOnRunner {
  jobs: { job: LocalTryOnJob; person: { width?: number; height?: number }; filesExist: boolean }[] = [];
  constructor(private readonly write = true) {}
  async run(job: LocalTryOnJob): Promise<void> {
    const person = await sharp(await readFile(job.person)).metadata();
    this.jobs.push({ job, person: { width: person.width, height: person.height }, filesExist: [job.person, job.mask, job.garment].every((f) => existsSync(f)) });
    if (this.write) await sharp({ create: { width: job.width, height: job.height, channels: 3, background: "#ff0000" } }).png().toFile(job.out);
  }
  close(): void {}
}

const grey = () => sharp({ create: { width: W, height: H, channels: 3, background: "#808080" } }).png().toBuffer();
const garment = () => sharp({ create: { width: 768, height: 1024, channels: 3, background: "#ffffff" } }).png().toBuffer();
const request = async () => ({ person: { data: await grey(), mimeType: "image/png" as const }, garment: { data: await garment(), mimeType: "image/png" as const }, category: "Dress" as const, reach: "ankles" as const });
const signal = new AbortController().signal;

async function pixel(image: Buffer, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * 3;
  return [data[i] ?? -1, data[i + 1] ?? -1, data[i + 2] ?? -1];
}

describe("LocalTryOn", () => {
  it("repaints only the garment's area and keeps the face, hands and backdrop", async () => {
    const runner = new RedRunner();
    const result = await new LocalTryOn({ runner, body: body(POSE), steps: 30, width: 384 }).tryOn(await request(), signal);
    const meta = await sharp(result).metadata();
    expect([meta.width, meta.height]).toEqual([W, H]);
    expect(await pixel(result, 300, 300)).toEqual([255, 0, 0]); // chest: the model's picture
    expect(await pixel(result, 300, 110)).toEqual([128, 128, 128]); // face: the photo's own
    expect(await pixel(result, 20, 400)).toEqual([128, 128, 128]); // backdrop
  });

  it("gives the model a 3:4 crop, its size and steps, in files it deletes afterwards", async () => {
    const runner = new RedRunner();
    await new LocalTryOn({ runner, body: body(POSE), steps: 20, width: 480 }).tryOn(await request(), signal);
    const [call] = runner.jobs;
    expect(call?.filesExist).toBe(true);
    // A 3:4 crop around the person, within the photo (600×800), at least the model's width.
    const cropWidth = call?.person.width ?? 0;
    const cropHeight = call?.person.height ?? 1;
    expect(cropWidth / cropHeight).toBeCloseTo(3 / 4, 2);
    expect(cropWidth).toBeGreaterThanOrEqual(384);
    expect(cropWidth).toBeLessThanOrEqual(600);
    expect(call?.job).toMatchObject({ steps: 20, width: 480, height: 640, seed: 42 });
    expect(existsSync(path.dirname(call?.job.person ?? "/nowhere/x"))).toBe(false);
  });

  it("refuses a photo where no body is found, and fails (retryably) when the model writes nothing", async () => {
    await expect(new LocalTryOn({ runner: new RedRunner(), body: body(null), steps: 30, width: 384 }).tryOn(await request(), signal)).rejects.toEqual(new AiJobRejected("PHOTO_BODY_NOT_VISIBLE"));
    const silent = new LocalTryOn({ runner: new RedRunner(false), body: body(POSE), steps: 30, width: 384 });
    await expect(silent.tryOn(await request(), signal)).rejects.toMatchObject({ name: "AiProviderError", retryable: true });
  });
});

/** A stand-in for the Python model process: answers each request line with `answer`. */
class FakeModel extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly requests: Record<string, unknown>[] = [];
  killed: string | null = null;

  constructor(answer: ((request: { id: string }) => Record<string, unknown> | null) | null, ready = true, answerAfterMs = 0) {
    super();
    if (ready) setImmediate(() => this.stdout.write(`${JSON.stringify({ ready: true, device: "cpu" })}\n`));
    this.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const parsed: unknown = JSON.parse(line);
        if (parsed === null || typeof parsed !== "object" || !("id" in parsed) || typeof parsed.id !== "string") continue;
        const req = { ...parsed, id: parsed.id };
        this.requests.push(req);
        const reply = answer?.(req);
        if (reply) setTimeout(() => this.stdout.write(`${JSON.stringify(reply)}\n`), answerAfterMs);
      }
    });
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killed = signal;
    setImmediate(() => this.emit("exit"));
    return true;
  }
}

const JOB: LocalTryOnJob = { person: "/tmp/p.png", mask: "/tmp/m.png", garment: "/tmp/g.png", out: "/tmp/o.png", steps: 30, width: 384, height: 512, seed: 42 };

function spawner(make: () => FakeModel) {
  const spawned: { model: FakeModel; env: Record<string, string>; args: string[] }[] = [];
  const spawn = (_python: string, args: string[], env: Record<string, string>): ModelProcess => {
    const model = make();
    spawned.push({ model, env, args });
    return model;
  };
  return { spawned, spawn };
}

describe("CatVtonProcess", () => {
  it("loads the model once, then sends each try-on and waits for its answer", async () => {
    const { spawned, spawn } = spawner(() => new FakeModel((r) => ({ id: r.id, ok: true, ms: 5 })));
    const runner = new CatVtonProcess({ python: "/py", weights: "/w", script: "/s.py", spawn });
    await runner.run(JOB, signal);
    await runner.run(JOB, signal);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.args).toEqual(["/s.py", "/w"]);
    expect(spawned[0]?.model.requests).toHaveLength(2);
    expect(spawned[0]?.model.requests[0]).toMatchObject({ person: "/tmp/p.png", steps: 30, width: 384, height: 512 });
    runner.close();
  });

  it("never hands the worker's keys to the model process, and keeps it offline", async () => {
    process.env.GEMINI_API_KEY = "not-for-python";
    const { spawned, spawn } = spawner(() => new FakeModel((r) => ({ id: r.id, ok: true })));
    const runner = new CatVtonProcess({ python: "/py", weights: "/w", spawn });
    await runner.run(JOB, signal);
    const env = spawned[0]?.env ?? {};
    expect(Object.keys(env).sort()).toEqual(["HF_HUB_OFFLINE", "HOME", "PATH", "PYTHONNOUSERSITE", "PYTHONUNBUFFERED", "PYTORCH_MPS_HIGH_WATERMARK_RATIO", "PYTORCH_MPS_LOW_WATERMARK_RATIO"]);
    expect(JSON.stringify(env)).not.toContain("not-for-python");
    delete process.env.GEMINI_API_KEY;
    runner.close();
  });

  it("turns the model's failures into provider errors: memory is retried, a bad request isn't", async () => {
    const answers = ["OUT_OF_MEMORY", "INVALID_REQUEST"];
    const { spawn } = spawner(() => new FakeModel((r) => ({ id: r.id, ok: false, error: answers.shift() })));
    const runner = new CatVtonProcess({ python: "/py", weights: "/w", spawn });
    await expect(runner.run(JOB, signal)).rejects.toMatchObject({ name: "AiProviderError", retryable: true });
    await expect(runner.run(JOB, signal)).rejects.toMatchObject({ name: "AiProviderError", retryable: false });
    runner.close();
  });

  it("kills a try-on that runs out of time, and starts afresh for the next one", async () => {
    let first = true;
    const { spawned, spawn } = spawner(() => {
      const hang = first;
      first = false;
      return new FakeModel(hang ? null : (r) => ({ id: r.id, ok: true }));
    });
    const runner = new CatVtonProcess({ python: "/py", weights: "/w", spawn });
    const controller = new AbortController();
    const stuck = runner.run(JOB, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(stuck).rejects.toEqual(new AiProviderError("local try-on aborted", true, "TIMEOUT"));
    expect(spawned[0]?.model.killed).toBe("SIGKILL");
    await runner.run(JOB, signal);
    expect(spawned).toHaveLength(2);
    runner.close();
  });

  it("doesn't let a killed process's late exit fail its replacement's try-on", async () => {
    let first = true;
    const { spawned, spawn } = spawner(() => {
      const hang = first;
      first = false;
      const model = new FakeModel(hang ? null : (r) => ({ id: r.id, ok: true }), true, 40);
      // The killed process only reports its exit later.
      if (hang) model.kill = (signal) => ((model.killed = signal), true);
      return model;
    });
    const runner = new CatVtonProcess({ python: "/py", weights: "/w", spawn });
    const controller = new AbortController();
    const stuck = runner.run(JOB, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(stuck).rejects.toMatchObject({ code: "TIMEOUT" });
    const next = runner.run(JOB, signal);
    setTimeout(() => spawned[0]?.model.emit("exit"), 5);
    await expect(next).resolves.toBeUndefined();
    runner.close();
  });

  it("fails retryably when the model process dies mid-try-on", async () => {
    const { spawned, spawn } = spawner(() => new FakeModel(null));
    const runner = new CatVtonProcess({ python: "/py", weights: "/w", spawn });
    const job = runner.run(JOB, signal);
    setTimeout(() => spawned[0]?.model.emit("exit"), 20);
    await expect(job).rejects.toMatchObject({ name: "AiProviderError", retryable: true });
    runner.close();
  });

  it("gives up when the model doesn't load in time", async () => {
    const { spawned, spawn } = spawner(() => new FakeModel(null, false));
    const runner = new CatVtonProcess({ python: "/py", weights: "/w", spawn, loadTimeoutMs: 30 });
    await expect(runner.run(JOB, signal)).rejects.toMatchObject({ code: "TIMEOUT", retryable: true });
    expect(spawned[0]?.model.killed).toBe("SIGKILL");
  });
});

describe("local try-on setup", () => {
  it("isn't ready until `pnpm tryon:setup` has checked everything", () => {
    expect(localTryOnReady(localTryOnPaths("/nonexistent/local-tryon"))).toBe(false);
  });
});
