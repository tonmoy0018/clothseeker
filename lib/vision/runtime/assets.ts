// The on-device vision files: six small models (five from Hugging Face, one from OpenMMLab) and the ONNX
// Runtime Web files.
// `pnpm vision:fetch` (scripts/fetch-vision-assets.ts) downloads the models, checks their SHA-256 and
// copies everything into public/vision/, so browsers load them only from our own site. Paths contain
// the version or hash, so they can be cached forever. Shared by the fetch script and the browser.

/** Must match the installed onnxruntime-web (checked by the fetch script). */
export const ORT_VERSION = "1.30.0";

export const VISION_BASE = "/vision";
export const ORT_PATH = `${VISION_BASE}/ort/${ORT_VERSION}/`;

/** The runtime files served from ORT_PATH: the WebGPU build and the plain WebAssembly build. */
export const ORT_FILES = ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"] as const;

export type VisionModelId = "pose" | "body" | "face" | "mask" | "matte" | "parts";

export type VisionModel = {
  id: VisionModelId;
  /** Hugging Face repository and file the model comes from (or, with `archive`, the publisher and the file in it). */
  repo: string;
  file: string;
  /** A model published only inside a zip on its maker's own site: the zip's URL; `file` is its path in the zip. */
  archive?: string;
  sha256: string;
  bytes: number;
  licence: string;
};

export const VISION_MODELS: Record<VisionModelId, VisionModel> = {
  // Full precision: the int8 and fp16 versions give near-zero scores in ONNX Runtime Web (tested).
  pose: {
    id: "pose",
    repo: "Xenova/movenet-singlepose-lightning",
    file: "onnx/model.onnx",
    sha256: "1ad4f8d6c2f776a9967db3993c9ca740bc350104f9d37c151dc183fc29a464ad",
    bytes: 9_413_268,
    licence: "Apache-2.0",
  },
  // The live mirror's body model (lib/vision/models/rtmpose.ts): far steadier elbows and hips than MoveNet.
  // OpenMMLab publishes its ONNX export only in a zip on its own download site (as rtmlib uses it); the
  // model file inside is pinned. The photo checks keep MoveNet, whose scores their rules were tuned on.
  body: {
    id: "body",
    repo: "open-mmlab/mmpose (RTMPose-s, body7)",
    file: "20230831/rtmpose_onnx/rtmpose-s_simcc-body7_pt-body7_420e-256x192-acd4a1ef_20230504/end2end.onnx",
    archive: "https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/rtmpose-s_simcc-body7_pt-body7_420e-256x192-acd4a1ef_20230504.zip",
    sha256: "9aeb635b83f86aea45cf45d85798f7eba1a162de8e0d721c44e54fe5eebaf47d",
    bytes: 21_890_172,
    licence: "Apache-2.0",
  },
  face: {
    id: "face",
    repo: "opencv/face_detection_yunet",
    file: "face_detection_yunet_2023mar_int8.onnx",
    sha256: "321aa5a6afabf7ecc46a3d06bfab2b579dc96eb5c3be7edd365fa04502ad9294",
    bytes: 100_416,
    licence: "MIT",
  },
  mask: {
    id: "mask",
    repo: "onnx-community/mediapipe_selfie_segmentation",
    file: "onnx/model_int8.onnx",
    sha256: "9bc3d56b0b1397acbdafb631ab5c7bf14a889c00fbe2018e36503c65a2b65983",
    bytes: 223_977,
    licence: "Apache-2.0",
  },
  // Portrait matting: the person outline when the browser has WebGPU (lib/vision/models/segment.ts).
  matte: {
    id: "matte",
    repo: "Xenova/modnet",
    file: "onnx/model_fp16.onnx",
    sha256: "25f165da9bfd30830a575f1f0490f1acd995975cb349bc02f3d79332e1fe5cf6",
    bytes: 12_984_781,
    licence: "Apache-2.0",
  },
  // Google's MediaPipe selfie multiclass model (hair, skin, clothes…), converted to ONNX unchanged.
  parts: {
    id: "parts",
    repo: "senty-au/selfie_multiclass_256x256-ONNX",
    file: "onnx/model.onnx",
    sha256: "35ec1ecd9ee7f85073c99c00020b7f6751b69506eeacf683bc8665f6117f85b0",
    bytes: 16_454_560,
    licence: "Apache-2.0",
  },
};

/** Where the browser loads a model from (the hash in the name makes it safe to cache forever). */
export function modelPath(model: VisionModel): string {
  return `${VISION_BASE}/models/${model.id}-${model.sha256.slice(0, 12)}.onnx`;
}

export function modelSourceUrl(model: VisionModel): string {
  return model.archive ?? `https://huggingface.co/${model.repo}/resolve/main/${model.file}`;
}
