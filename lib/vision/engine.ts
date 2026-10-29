import type * as Ort from "onnxruntime-web";

import { modelPath, ORT_PATH, VISION_MODELS, type VisionModelId } from "./assets";
import { fitSquare, type FitBox } from "./geometry";
import { decodeMovenet, MOVENET_SIZE, movenetInput, type Pose } from "./movenet";
import { meanBrightness } from "./photo-check";
import { SELFIE_SIZE, selfieInput } from "./segment";
import { decodeYunet, YUNET_SIZE, yunetInput, type Face } from "./yunet";

// Runs the vision models in the browser (inside a Web Worker, see vision.worker.ts). Uses WebGPU when the
// browser has it, else WebAssembly; single-threaded, because the site isn't cross-origin isolated.
// Frames are letterboxed on an OffscreenCanvas, so the model inputs are never distorted.

export type VisionBackend = "webgpu" | "wasm";

export type VisionRequest = { pose?: boolean; face?: boolean; mask?: boolean };

export type VisionResult = {
  width: number;
  height: number;
  pose: Pose | null;
  faces: Face[] | null;
  /** Mean brightness 0–255 (measured with the body model's input). */
  brightness: number | null;
  /** Person likelihood (SELFIE_SIZE² values, letterbox space) and how it maps to the frame. */
  mask: { alpha: Float32Array; box: FitBox } | null;
  /** Milliseconds per model, for the speed check. */
  ms: Partial<Record<VisionModelId, number>>;
};

type OrtModule = typeof Ort;

async function loadOrt(gpu: boolean): Promise<OrtModule> {
  const ort = gpu ? await import("onnxruntime-web/webgpu") : await import("onnxruntime-web/wasm");
  ort.env.wasm.wasmPaths = ORT_PATH;
  ort.env.wasm.numThreads = 1;
  return ort;
}

/** A canvas that letterboxes frames into a size×size square and reads the pixels back. */
class Letterbox {
  private readonly canvas: OffscreenCanvas;
  private readonly context: OffscreenCanvasRenderingContext2D;

  constructor(readonly size: number) {
    this.canvas = new OffscreenCanvas(size, size);
    const context = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("2D canvas unavailable");
    this.context = context;
  }

  read(frame: CanvasImageSource, width: number, height: number): { rgba: Uint8ClampedArray; box: FitBox } {
    const box = fitSquare(width, height, this.size);
    this.context.fillStyle = "#000";
    this.context.fillRect(0, 0, this.size, this.size);
    this.context.drawImage(frame, box.offsetX, box.offsetY, box.width, box.height);
    return { rgba: this.context.getImageData(0, 0, this.size, this.size).data, box };
  }
}

export class VisionEngine {
  private readonly letterboxes = { pose: new Letterbox(MOVENET_SIZE), face: new Letterbox(YUNET_SIZE), mask: new Letterbox(SELFIE_SIZE) };

  private constructor(
    private readonly ort: OrtModule,
    readonly backend: VisionBackend,
    private readonly sessions: Partial<Record<VisionModelId, Ort.InferenceSession>>,
  ) {}

  /** Loads the requested models: WebGPU first when available, falling back to WebAssembly per model. */
  static async create(models: readonly VisionModelId[], wasmOnly = false): Promise<VisionEngine> {
    const gpu = !wasmOnly && (await gpuAdapter());
    const ort = await loadOrt(gpu);
    const backend: VisionBackend = gpu ? "webgpu" : "wasm";
    const sessions: Partial<Record<VisionModelId, Ort.InferenceSession>> = {};
    for (const id of models) {
      try {
        sessions[id] = await ort.InferenceSession.create(modelPath(VISION_MODELS[id]), {
          executionProviders: gpu ? ["webgpu", "wasm"] : ["wasm"],
          graphOptimizationLevel: "all",
        });
      } catch (error) {
        for (const done of Object.values(sessions)) await done.release();
        // This browser's WebGPU can't run the model: use WebAssembly for everything.
        if (gpu) return VisionEngine.create(models, true);
        throw error;
      }
    }
    return new VisionEngine(ort, backend, sessions);
  }

  async analyse(frame: CanvasImageSource, width: number, height: number, request: VisionRequest): Promise<VisionResult> {
    const result: VisionResult = { width, height, pose: null, faces: null, brightness: null, mask: null, ms: {} };
    const timed = async <T>(id: VisionModelId, work: () => Promise<T>): Promise<T> => {
      const start = performance.now();
      const value = await work();
      result.ms[id] = Math.round((performance.now() - start) * 10) / 10;
      return value;
    };

    const pose = this.sessions.pose;
    if (request.pose && pose) {
      result.pose = await timed("pose", async () => {
        const { rgba, box } = this.letterboxes.pose.read(frame, width, height);
        result.brightness = meanBrightness(rgba, box);
        const out = await pose.run({ input: new this.ort.Tensor("int32", movenetInput(rgba), [1, MOVENET_SIZE, MOVENET_SIZE, 3]) });
        return decodeMovenet(await floats(out.output_0), box);
      });
    }
    const face = this.sessions.face;
    if (request.face && face) {
      result.faces = await timed("face", async () => {
        const { rgba, box } = this.letterboxes.face.read(frame, width, height);
        const out = await face.run({ input: new this.ort.Tensor("float32", yunetInput(rgba), [1, 3, YUNET_SIZE, YUNET_SIZE]) });
        const outputs: Record<string, Float32Array> = {};
        for (const [name, tensor] of Object.entries(out)) outputs[name] = await floats(tensor);
        return decodeYunet(outputs, box);
      });
    }
    const mask = this.sessions.mask;
    if (request.mask && mask) {
      result.mask = await timed("mask", async () => {
        const { rgba, box } = this.letterboxes.mask.read(frame, width, height);
        const out = await mask.run({ pixel_values: new this.ort.Tensor("float32", selfieInput(rgba), [1, 3, SELFIE_SIZE, SELFIE_SIZE]) });
        return { alpha: await floats(out.alphas), box };
      });
    }
    return result;
  }

  async dispose(): Promise<void> {
    for (const session of Object.values(this.sessions)) await session.release();
  }
}

/** Whether the browser can actually give us a WebGPU adapter (having `navigator.gpu` isn't enough). */
async function gpuAdapter(): Promise<boolean> {
  try {
    const gpu: unknown = Reflect.get(navigator, "gpu");
    if (gpu === null || typeof gpu !== "object") return false;
    const request: unknown = Reflect.get(gpu, "requestAdapter");
    if (typeof request !== "function") return false;
    const adapter: unknown = await Reflect.apply(request, gpu, []);
    return adapter !== null && adapter !== undefined;
  } catch {
    return false;
  }
}

/** A float32 output tensor's values (downloaded from the GPU when needed). */
async function floats(tensor: Ort.Tensor | undefined): Promise<Float32Array> {
  if (!tensor) throw new Error("model output missing");
  const data = tensor.location === "cpu" ? tensor.data : await tensor.getData();
  if (!(data instanceof Float32Array)) throw new Error("unexpected model output type");
  return data;
}
