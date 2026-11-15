import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";

import { AiProviderError } from "../errors";
import type { GarmentModelProvider, ProviderImage } from "../types";
import type { ModelSlot } from "./model-slot";
import { PythonModelProcess, type SpawnModel } from "./python-model";

// The 3D view's model on our own machine (MODEL3D_PROVIDER=local): TripoSR (worker/local-3d/triposr_server.py,
// a Python process kept running between jobs) turns the garment's cut-out into a coloured mesh in about
// 10 seconds on the 8 GB Mac. The front follows the picture; the back and sides are its guess.
// Setup: `pnpm model3d:setup` (docs/developers/3d-view.md).

/** Marching-cubes grid: 192 gives about 60 000 vertices (a 1 MB model) in about 6 s on the CPU. */
export const MESH_RESOLUTION = 192;

/** One model for the process: absolute paths in a private temporary folder. */
export type LocalModelJob = { picture: string; out: string; resolution: number };

/** Runs model jobs one at a time (TripoSrProcess; a fake in tests). */
export interface LocalModelRunner {
  run(job: LocalModelJob, signal: AbortSignal): Promise<void>;
  close(): void;
}

export type TripoSrOptions = {
  /** The setup's Python, the model folder and TripoSR's code (`pnpm model3d:setup`). */
  python: string;
  weights: string;
  source: string;
  script?: string;
  idleMs?: number;
  loadTimeoutMs?: number;
  /** Shared with the other big local models: loading this one stops whichever holds the memory. */
  slot?: ModelSlot;
  spawn?: SpawnModel;
};

/** The TripoSR process (worker/local-3d/triposr_server.py). */
export class TripoSrProcess extends PythonModelProcess<LocalModelJob> implements LocalModelRunner {
  constructor({ python, weights, source, script, ...rest }: TripoSrOptions) {
    super({
      ...rest,
      python,
      script: script ?? path.join(process.cwd(), "worker", "local-3d", "triposr_server.py"),
      args: [weights, source],
      label: "local 3D model",
      // Caps what the Mac's GPU may hold (of its memory), as for the try-on model.
      env: { PYTORCH_MPS_HIGH_WATERMARK_RATIO: "0.55", PYTORCH_MPS_LOW_WATERMARK_RATIO: "0.45" },
    });
  }
}

export class LocalGarmentModel implements GarmentModelProvider {
  readonly name = "local";

  constructor(private readonly runner: LocalModelRunner) {}

  close(): void {
    this.runner.close();
  }

  async buildModel(garment: ProviderImage, signal: AbortSignal): Promise<Buffer> {
    const dir = await mkdtemp(path.join(tmpdir(), "clothseeker-3d-"));
    try {
      const picture = path.join(dir, "garment.png");
      const out = path.join(dir, "model.glb");
      // Re-encoded here (the model reads only a plain RGBA PNG), at most 1024 px.
      await sharp(garment.data).ensureAlpha().resize(1024, 1024, { fit: "inside", withoutEnlargement: true }).png().toFile(picture);
      await this.runner.run({ picture, out, resolution: MESH_RESOLUTION }, signal);
      const model = await readFile(out).catch(() => null);
      if (!model) {
        throw new AiProviderError("local 3D model wrote no file", true);
      }
      return model;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
