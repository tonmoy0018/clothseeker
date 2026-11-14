import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import * as ort from "onnxruntime-web";
import sharp from "sharp";

import { modelPath, VISION_MODELS } from "./assets";
import { fitSquare, type FitBox } from "../models/geometry";
import { decodeMovenet, MOVENET_SIZE, movenetInput } from "../models/movenet";
import { decodeParts, PARTS_INPUT, PARTS_OUTPUT, PARTS_SIZE, partsInput, type BodyParts } from "../models/parts";
import { meanBrightness, type PhotoAnalysis } from "../photo/photo-check";
import { SELFIE_SIZE, selfieInput, type PersonMask } from "../models/segment";
import { decodeYunet, YUNET_SIZE, yunetInput } from "../models/yunet";

// The on-device body and face models, run in Node by the worker (our own machine; no third party sees
// the photo). Same model files as the browser (public/vision/, `pnpm vision:fetch`), same decoding.

// Errors only, set before the runtime starts: nothing the models print belongs in the worker's log.
ort.env.logLevel = "error";

const MODEL_IDS = ["pose", "face", "mask", "parts"] as const;

/** Where the worker finds the model files; missing files mean `pnpm vision:fetch` hasn't run. */
export function nodeModelFile(id: (typeof MODEL_IDS)[number]): string {
  return path.join(process.cwd(), "public", modelPath(VISION_MODELS[id]));
}

export function nodeModelsPresent(): boolean {
  return MODEL_IDS.every((id) => existsSync(nodeModelFile(id)));
}

/** A photo letterboxed into a size×size RGBA square (smooth downscaling with sharp). */
async function letterbox(image: Buffer, width: number, height: number, size: number): Promise<{ rgba: Buffer; box: FitBox }> {
  const box = fitSquare(width, height, size);
  const rgba = await sharp(image)
    .rotate()
    .resize(box.width, box.height, { fit: "fill" })
    .extend({
      top: box.offsetY,
      left: box.offsetX,
      bottom: size - box.height - box.offsetY,
      right: size - box.width - box.offsetX,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    })
    .ensureAlpha()
    .raw()
    .toBuffer();
  return { rgba, box };
}

function floats(tensor: ort.Tensor | undefined): Float32Array {
  if (!tensor || !(tensor.data instanceof Float32Array)) throw new Error("unexpected model output");
  return tensor.data;
}

export class NodeVision {
  private sessions: Promise<{ pose: ort.InferenceSession; face: ort.InferenceSession }> | null = null;
  private maskSession: Promise<ort.InferenceSession> | null = null;
  private partsSession: Promise<ort.InferenceSession> | null = null;

  private load() {
    ort.env.wasm.numThreads = 1;
    this.sessions ??= (async () => ({
      pose: await ort.InferenceSession.create(await readFile(nodeModelFile("pose"))),
      face: await ort.InferenceSession.create(await readFile(nodeModelFile("face"))),
    }))();
    return this.sessions;
  }

  /** How likely each pixel is part of the person (the local try-on's mask, lib/tryon/mask.ts). */
  async personMask(image: Buffer): Promise<PersonMask> {
    ort.env.wasm.numThreads = 1;
    this.maskSession ??= readFile(nodeModelFile("mask")).then((file) => ort.InferenceSession.create(file));
    const session = await this.maskSession;
    const meta = await sharp(image).rotate().metadata();
    const { rgba, box } = await letterbox(image, meta.autoOrient.width, meta.autoOrient.height, SELFIE_SIZE);
    const out = await session.run({ pixel_values: new ort.Tensor("float32", selfieInput(rgba), [1, 3, SELFIE_SIZE, SELFIE_SIZE]) });
    return { alpha: floats(out.alphas), box };
  }

  /**
   * What each pixel of `region` is (hair, skin, clothes…). The model expects the person to fill the
   * picture: pass a box around them (in the upright photo's pixels), not the whole photo.
   */
  async bodyParts(image: Buffer, region: BodyParts["region"]): Promise<BodyParts> {
    ort.env.wasm.numThreads = 1;
    // Errors only: the converted model makes the runtime print a harmless warning per layer.
    this.partsSession ??= readFile(nodeModelFile("parts")).then((file) => ort.InferenceSession.create(file, { logSeverityLevel: 3 }));
    const session = await this.partsSession;
    const rgb = await sharp(image).rotate().extract(region).resize(PARTS_SIZE, PARTS_SIZE, { fit: "fill" }).removeAlpha().raw().toBuffer();
    const out = await session.run({ [PARTS_INPUT]: new ort.Tensor("float32", partsInput(rgb, 3), [1, PARTS_SIZE, PARTS_SIZE, 3]) });
    return { classes: decodeParts(floats(out[PARTS_OUTPUT])), region };
  }

  async analyse(image: Buffer): Promise<PhotoAnalysis> {
    const { pose, face } = await this.load();
    const meta = await sharp(image).rotate().metadata();
    const width = meta.autoOrient.width;
    const height = meta.autoOrient.height;

    const body = await letterbox(image, width, height, MOVENET_SIZE);
    const poseOut = await pose.run({ input: new ort.Tensor("int32", movenetInput(body.rgba), [1, MOVENET_SIZE, MOVENET_SIZE, 3]) });

    const head = await letterbox(image, width, height, YUNET_SIZE);
    const faceOut = await face.run({ input: new ort.Tensor("float32", yunetInput(head.rgba), [1, 3, YUNET_SIZE, YUNET_SIZE]) });
    const outputs: Record<string, Float32Array> = {};
    for (const [name, tensor] of Object.entries(faceOut)) outputs[name] = floats(tensor);

    return {
      width,
      height,
      pose: decodeMovenet(floats(poseOut.output_0), body.box),
      faces: decodeYunet(outputs, head.box),
      brightness: meanBrightness(body.rgba, body.box),
    };
  }
}
