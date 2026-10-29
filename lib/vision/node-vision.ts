import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import * as ort from "onnxruntime-web";
import sharp from "sharp";

import { modelPath, VISION_MODELS } from "./assets";
import { fitSquare, type FitBox } from "./geometry";
import { decodeMovenet, MOVENET_SIZE, movenetInput } from "./movenet";
import { meanBrightness, type PhotoAnalysis } from "./photo-check";
import { decodeYunet, YUNET_SIZE, yunetInput } from "./yunet";

// The on-device body and face models, run in Node by the worker (our own machine; no third party sees
// the photo). Same model files as the browser (public/vision/, `pnpm vision:fetch`), same decoding.

const MODEL_IDS = ["pose", "face"] as const;

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

  private load() {
    ort.env.wasm.numThreads = 1;
    this.sessions ??= (async () => ({
      pose: await ort.InferenceSession.create(await readFile(nodeModelFile("pose"))),
      face: await ort.InferenceSession.create(await readFile(nodeModelFile("face"))),
    }))();
    return this.sessions;
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
