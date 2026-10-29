import type { VisionModelId } from "./assets";
import type { VisionBackend, VisionRequest, VisionResult } from "./engine";

// Messages between the page (client.ts) and the vision worker (vision.worker.ts).

export type ToWorker = { type: "init"; models: VisionModelId[] } | { type: "analyse"; id: number; frame: ImageBitmap; request: VisionRequest };

export type FromWorker =
  | { type: "ready"; backend: VisionBackend }
  | { type: "failed"; message: string }
  | { type: "result"; id: number; result: VisionResult }
  | { type: "error"; id: number; message: string };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export function isToWorker(value: unknown): value is ToWorker {
  if (!isObject(value)) return false;
  if (value.type === "init") return Array.isArray(value.models);
  const isBitmap = typeof ImageBitmap !== "undefined" && value.frame instanceof ImageBitmap;
  return value.type === "analyse" && typeof value.id === "number" && isBitmap && isObject(value.request);
}

export function isFromWorker(value: unknown): value is FromWorker {
  if (!isObject(value)) return false;
  switch (value.type) {
    case "ready":
      return value.backend === "webgpu" || value.backend === "wasm";
    case "failed":
      return typeof value.message === "string";
    case "result":
      return typeof value.id === "number" && isObject(value.result);
    case "error":
      return typeof value.id === "number" && typeof value.message === "string";
    default:
      return false;
  }
}
