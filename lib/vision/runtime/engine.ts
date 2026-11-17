import type * as Ort from "onnxruntime-web";

import { modelPath, ORT_PATH, VISION_MODELS, type VisionModelId } from "./assets";
import { fitRect, fitSquare, type FitBox } from "../models/geometry";
import { decodeMovenet, MOVENET_SIZE, movenetInput, type Pose } from "../models/movenet";
import { decodeParts, PARTS_INPUT, PARTS_OUTPUT, PARTS_SIZE, partsInput, type BodyParts } from "../models/parts";
import { cropFor, decodeRtmpose, maskBox, poseBox, RTMPOSE_HEIGHT, RTMPOSE_WIDTH, rtmposeInput, unionBox, type Box } from "../models/rtmpose";
import { meanBrightness } from "../photo/photo-check";
import { matteInput, matteSize, SELFIE_SIZE, selfieInput, type PersonMask } from "../models/segment";
import { decodeYunet, YUNET_SIZE, yunetInput, type Face } from "../models/yunet";

// Runs the vision models in the browser (inside a Web Worker, see vision.worker.ts). Uses WebGPU when the
// browser has it, else WebAssembly; single-threaded, because the site isn't cross-origin isolated.
// Frames are letterboxed on an OffscreenCanvas, so the model inputs are never distorted.

export type VisionBackend = "webgpu" | "wasm";

/** `parts`: the region of the frame (its pixels) to read hair, skin and clothes in: the model wants the person to fill it. */
export type VisionRequest = { pose?: boolean; face?: boolean; mask?: boolean; parts?: BodyParts["region"] };

export type VisionResult = {
  width: number;
  height: number;
  pose: Pose | null;
  faces: Face[] | null;
  /** Mean brightness 0–255 (measured with the body model's input). */
  brightness: number | null;
  /** Person likelihood (in the outline model's letterboxed space) and how it maps to the frame. */
  mask: PersonMask | null;
  /** What each pixel of the requested region is (hair, skin, clothes…), or null when not asked or not available. */
  parts: BodyParts | null;
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

/**
 * A canvas that letterboxes frames into a size×size square (or, with `read`'s `into`, a rectangle of the
 * frame's own shape) and reads the pixels back.
 */
class Letterbox {
  private readonly canvas: OffscreenCanvas;
  private readonly context: OffscreenCanvasRenderingContext2D;

  constructor(readonly size: number) {
    this.canvas = new OffscreenCanvas(size, size);
    const context = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("2D canvas unavailable");
    this.context = context;
  }

  read(frame: CanvasImageSource, width: number, height: number, into?: { width: number; height: number }): { rgba: Uint8ClampedArray; box: FitBox } {
    const w = into?.width ?? this.size;
    const h = into?.height ?? this.size;
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    const box = into ? fitRect(width, height, w, h) : fitSquare(width, height, this.size);
    this.context.fillStyle = "#000";
    this.context.fillRect(0, 0, w, h);
    this.context.drawImage(frame, box.offsetX, box.offsetY, box.width, box.height);
    return { rgba: this.context.getImageData(0, 0, w, h).data, box };
  }
}

export class VisionEngine {
  private readonly letterboxes = { pose: new Letterbox(MOVENET_SIZE), face: new Letterbox(YUNET_SIZE), mask: new Letterbox(SELFIE_SIZE), matte: new Letterbox(SELFIE_SIZE) };
  private stretch: OffscreenCanvasRenderingContext2D | null = null;
  private bodyCrop: OffscreenCanvasRenderingContext2D | null = null;
  /** Where the body model looks next: around the last pose, else the last outline (null: not found yet). */
  private tracked: Box | null = null;
  private lastOutline: Box | null = null;
  /** The frame size they were found in: another size (a photo after the camera) starts afresh. */
  private trackedIn = "";

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
      if (id === "parts" || id === "matte") continue;
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
    // The body-parts model is a help, not a need (the mirror works without it), and the larger download:
    // if it can't load, the others go on without it rather than all falling back to WebAssembly.
    if (models.includes("parts")) {
      try {
        sessions.parts = await ort.InferenceSession.create(modelPath(VISION_MODELS.parts), { executionProviders: gpu ? ["webgpu", "wasm"] : ["wasm"], graphOptimizationLevel: "all" });
      } catch {
        // Left out: no parts in the results.
      }
    }
    // The sharper outline (portrait matting), for those who ask for it, and only with a GPU: without one
    // it's 8× slower than the selfie model. Optional like the parts model: if it can't load, the selfie
    // model draws the outline. (The try-on's body measurement keeps the selfie model it was tuned on.)
    if (gpu && models.includes("matte")) {
      try {
        sessions.matte = await ort.InferenceSession.create(modelPath(VISION_MODELS.matte), { executionProviders: ["webgpu", "wasm"], graphOptimizationLevel: "all" });
      } catch {
        // Left out: the selfie model's outline.
      }
    }
    return new VisionEngine(ort, backend, sessions);
  }

  async analyse(frame: CanvasImageSource, width: number, height: number, request: VisionRequest): Promise<VisionResult> {
    const result: VisionResult = { width, height, pose: null, faces: null, brightness: null, mask: null, parts: null, ms: {} };
    const timed = async <T>(id: VisionModelId, work: () => Promise<T>): Promise<T> => {
      const start = performance.now();
      const value = await work();
      result.ms[id] = Math.round((performance.now() - start) * 10) / 10;
      return value;
    };

    const matte = this.sessions.matte;
    const mask = this.sessions.mask;
    if (request.mask && matte) {
      result.mask = await timed("matte", async () => {
        const size = matteSize(width, height);
        const { rgba, box } = this.letterboxes.matte.read(frame, width, height, size);
        const out = await matte.run({ input: new this.ort.Tensor("float32", matteInput(rgba, size.width, size.height), [1, 3, size.height, size.width]) });
        return { alpha: await floats(out.output), width: size.width, height: size.height, box };
      });
    } else if (request.mask && mask) {
      result.mask = await timed("mask", async () => {
        const { rgba, box } = this.letterboxes.mask.read(frame, width, height);
        const out = await mask.run({ pixel_values: new this.ort.Tensor("float32", selfieInput(rgba), [1, 3, SELFIE_SIZE, SELFIE_SIZE]) });
        return { alpha: await floats(out.alphas), width: SELFIE_SIZE, height: SELFIE_SIZE, box };
      });
    }
    const body = this.sessions.body;
    const pose = this.sessions.pose;
    if (request.pose && body) {
      result.pose = await timed("body", async () => {
        // Top-down: the person is looked for around their last pose, widened to this frame's outline when
        // there is one (legs coming into view as they step back), else by the last outline, else in the
        // whole frame. Once found, the pose itself keeps track of them.
        if (this.trackedIn !== `${width}x${height}`) {
          this.trackedIn = `${width}x${height}`;
          this.tracked = null;
          this.lastOutline = null;
        }
        const outline = result.mask ? maskBox(result.mask) : null;
        if (outline) this.lastOutline = outline;
        const crop = cropFor(unionBox(this.tracked, outline) ?? this.lastOutline ?? { x: 0, y: 0, width, height });
        this.bodyCrop ??= new OffscreenCanvas(RTMPOSE_WIDTH, RTMPOSE_HEIGHT).getContext("2d", { willReadFrequently: true });
        const context = this.bodyCrop;
        if (!context) throw new Error("2D canvas unavailable");
        const scale = RTMPOSE_WIDTH / crop.width;
        context.fillStyle = "#000";
        context.fillRect(0, 0, RTMPOSE_WIDTH, RTMPOSE_HEIGHT);
        context.drawImage(frame, -crop.x * scale, -crop.y * scale, width * scale, height * scale);
        const rgba = context.getImageData(0, 0, RTMPOSE_WIDTH, RTMPOSE_HEIGHT).data;
        const out = await body.run({ input: new this.ort.Tensor("float32", rtmposeInput(rgba), [1, 3, RTMPOSE_HEIGHT, RTMPOSE_WIDTH]) });
        const found = decodeRtmpose(await floats(out.simcc_x), await floats(out.simcc_y), crop);
        this.tracked = poseBox(found);
        return found;
      });
    } else if (request.pose && pose) {
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
    const parts = this.sessions.parts;
    const region = request.parts;
    if (region && parts && region.width >= 8 && region.height >= 8) {
      result.parts = await timed("parts", async () => {
        // The region stretched to the model's square (it was made that way, not letterboxed).
        this.stretch ??= new OffscreenCanvas(PARTS_SIZE, PARTS_SIZE).getContext("2d", { willReadFrequently: true });
        const context = this.stretch;
        if (!context) throw new Error("2D canvas unavailable");
        context.drawImage(frame, region.left, region.top, region.width, region.height, 0, 0, PARTS_SIZE, PARTS_SIZE);
        const rgba = context.getImageData(0, 0, PARTS_SIZE, PARTS_SIZE).data;
        const out = await parts.run({ [PARTS_INPUT]: new this.ort.Tensor("float32", partsInput(rgba, 4), [1, PARTS_SIZE, PARTS_SIZE, 3]) });
        return { classes: decodeParts(await floats(out[PARTS_OUTPUT])), region };
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
