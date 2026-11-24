import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { FakeGarmentModel } from "@/lib/ai/providers/fake";
import { LocalGarmentModel, MESH_RESOLUTION, TripoSrProcess, type LocalModelJob, type LocalModelRunner } from "@/lib/ai/providers/model3d-local";
import { local3dPaths, local3dReady } from "@/lib/ai/providers/model3d-local-setup";
import type { ModelProcess } from "@/lib/ai/providers/python-model";
import { checkGlb, GlbError, MAX_MODEL_BYTES, writeGlb } from "@/lib/model3d/glb";

// The 3D view's models: the GLB every provider's output must be (self-contained, within limits), the
// fake used in development and tests, and the local TripoSR process (faked here).

const signal = new AbortController().signal;

/** A garment on a transparent backdrop: a 200×300 red rectangle in a 400×400 picture. */
function garment(): Promise<Buffer> {
  const pixels = Buffer.alloc(400 * 400 * 4);
  for (let y = 50; y < 350; y += 1) for (let x = 100; x < 300; x += 1) pixels.set([200, 30, 40, 255], (y * 400 + x) * 4);
  return sharp(pixels, { raw: { width: 400, height: 400, channels: 4 } }).png().toBuffer();
}

async function triangle(): Promise<Buffer> {
  const texture = await sharp({ create: { width: 2, height: 2, channels: 4, background: "#ff0000" } }).png().toBuffer();
  return writeGlb({ positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), uvs: Float32Array.from([0, 0, 1, 0, 0, 1]), indices: Uint32Array.from([0, 1, 2]), texture });
}

/** The GLB's JSON chunk, changed by `edit`, put back with the right lengths. */
function withJson(glb: Buffer, edit: (json: Record<string, unknown>) => void): Buffer {
  const length = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + length).toString("utf8")) as Record<string, unknown>;
  edit(json);
  const text = Buffer.from(JSON.stringify(json));
  const chunk = Buffer.alloc((text.length + 3) & ~3, 0x20);
  text.copy(chunk);
  const rest = glb.subarray(20 + length);
  const out = Buffer.concat([glb.subarray(0, 20), chunk, rest]);
  out.writeUInt32LE(chunk.length, 12);
  out.writeUInt32LE(out.length, 8);
  return out;
}

describe("GLB models", () => {
  it("writes a model the checker accepts", async () => {
    expect(checkGlb(await triangle())).toEqual({ bytes: (await triangle()).length, meshes: 1, vertices: 3 });
  });

  it("refuses anything that isn't a self-contained model within the limits", async () => {
    const good = await triangle();
    const refused = (bytes: Uint8Array) => {
      try {
        checkGlb(bytes);
        return null;
      } catch (error) {
        return error instanceof GlbError ? error.message : String(error);
      }
    };
    expect(refused(Buffer.from("not a model at all, just text"))).toBe("header");
    expect(refused(good.subarray(0, good.length - 4))).toBe("header");
    // A buffer or picture fetched from elsewhere would make the viewer reach another site.
    expect(refused(withJson(good, (j) => ((j.buffers as Record<string, unknown>[])[0] = { byteLength: 10, uri: "https://example.com/x.bin" })))).toBe("structure");
    expect(refused(withJson(good, (j) => ((j.images as Record<string, unknown>[])[0] = { uri: "https://example.com/x.png" })))).toBe("structure");
    expect(refused(withJson(good, (j) => ((j.asset as Record<string, unknown>).version = "1.0")))).toBe("structure");
    expect(refused(withJson(good, (j) => ((j.buffers as Record<string, unknown>[])[0] = { byteLength: 10_000_000 })))).toBe("binary chunk");
    expect(refused(withJson(good, (j) => ((j.accessors as Record<string, unknown>[])[0] = { count: 0 })))).toBe("vertices");
    expect(refused(Buffer.alloc(MAX_MODEL_BYTES + 1))).toBe("size");
  });
});

describe("FakeGarmentModel", () => {
  it("bulges the garment's picture into a card, the same every time", async () => {
    const picture = { data: await garment(), mimeType: "image/png" as const };
    const model = await new FakeGarmentModel().buildModel(picture, signal);
    // Front and back grids of 17 × 25 points.
    expect(checkGlb(model)).toMatchObject({ meshes: 1, vertices: 2 * 17 * 25 });
    expect((await new FakeGarmentModel().buildModel(picture, signal)).equals(model)).toBe(true);
  });
});

/** Writes a fixed model where the job says (or nothing), and remembers the job. */
class StubRunner implements LocalModelRunner {
  readonly jobs: LocalModelJob[] = [];

  constructor(private readonly model: Buffer | null) {}

  async run(job: LocalModelJob): Promise<void> {
    this.jobs.push(job);
    if (this.model) await writeFile(job.out, this.model);
  }

  close(): void {}
}

/** A stand-in for the Python model process: answers every request with ok. */
class FakeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly requests: Record<string, unknown>[] = [];

  constructor() {
    super();
    setImmediate(() => this.stdout.write(`${JSON.stringify({ ready: true })}\n`));
    this.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const request = JSON.parse(line) as Record<string, unknown>;
        this.requests.push(request);
        setImmediate(() => this.stdout.write(`${JSON.stringify({ id: request.id, ok: true })}\n`));
      }
    });
  }

  kill(): boolean {
    setImmediate(() => this.emit("exit"));
    return true;
  }
}

describe("the 3D model on this machine", () => {
  it("hands the model a plain PNG and returns what it wrote, or fails retryably when it wrote nothing", async () => {
    const model = await triangle();
    const runner = new StubRunner(model);
    expect((await new LocalGarmentModel(runner).buildModel({ data: await garment(), mimeType: "image/png" }, signal)).equals(model)).toBe(true);
    expect(runner.jobs[0]).toMatchObject({ resolution: MESH_RESOLUTION });
    expect(runner.jobs[0]?.picture.endsWith(".png")).toBe(true);
    await expect(new LocalGarmentModel(new StubRunner(null)).buildModel({ data: await garment(), mimeType: "image/png" }, signal)).rejects.toMatchObject({ name: "AiProviderError", retryable: true });
  });

  it("starts TripoSR with the model folder and its code, offline and without the worker's keys", async () => {
    process.env.GEMINI_API_KEY = "not-for-python";
    const spawned: { args: string[]; env: Record<string, string>; model: FakeProcess }[] = [];
    const spawn = (_python: string, args: string[], env: Record<string, string>): ModelProcess => {
      const model = new FakeProcess();
      spawned.push({ args, env, model });
      return model;
    };
    const runner = new TripoSrProcess({ python: "/py", weights: "/w", source: "/src", script: "/s.py", spawn });
    await runner.run({ picture: "/tmp/g.png", out: "/tmp/m.glb", resolution: 192 }, signal);
    expect(spawned[0]?.args).toEqual(["/s.py", "/w", "/src"]);
    expect(spawned[0]?.model.requests[0]).toMatchObject({ picture: "/tmp/g.png", out: "/tmp/m.glb", resolution: 192 });
    expect(spawned[0]?.env.HF_HUB_OFFLINE).toBe("1");
    expect(JSON.stringify(spawned[0]?.env)).not.toContain("not-for-python");
    delete process.env.GEMINI_API_KEY;
    runner.close();
  });

  it("isn't ready until `pnpm model3d:setup` has checked everything", () => {
    expect(local3dReady(local3dPaths("/nonexistent/local-3d"))).toBe(false);
  });
});
