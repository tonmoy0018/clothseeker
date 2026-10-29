# Live try-on: on-device vision

The live mirror (camera) and the try-on photo checks find the customer's body and face **in their own browser**. Nothing is uploaded for this: the models are downloaded once from our own site and run in a Web Worker. The realistic AI photo try-on ([try-on.md](try-on.md)) is separate.

Status: **steps 1 and 2 of 3 are done**: models, runtime and the speed check; try-on photo checks on the device and in the worker (see [try-on.md](try-on.md#photo-checks)). Step 3 is the live mirror itself.

## Models (all from Hugging Face)

| Job | Model | File | Size | Licence |
|---|---|---|---|---|
| Body: 17 points (nose, eyes, ears, shoulders, elbows, wrists, hips, knees, ankles; the person's own left/right) | `Xenova/movenet-singlepose-lightning` | `onnx/model.onnx` (fp32) | 9.4 MB | Apache-2.0 |
| Faces: boxes and 5 landmarks, also small faces at full-body distance | `opencv/face_detection_yunet` | `face_detection_yunet_2023mar_int8.onnx` | 0.1 MB | MIT |
| Person outline (to put arms in front of the garment) | `onnx-community/mediapipe_selfie_segmentation` | `onnx/model_int8.onnx` | 0.2 MB | Apache-2.0 |

- **Use the fp32 MoveNet.** Its int8 and fp16 versions give near-zero scores in ONNX Runtime Web (checked on 2026-10-29).
- Each model is pinned by SHA-256 in [`lib/vision/assets.ts`](../../lib/vision/assets.ts). If a file on Hugging Face changes, the fetch fails rather than serving something unchecked.
- Google's MediaPipe pose models track a little better, but they aren't hosted on Hugging Face. Jitter is handled by smoothing instead (`OneEuro` in `lib/vision/smooth.ts`).

## Runtime

- **ONNX Runtime Web 1.30.0** (MIT), pinned exactly. It uses **WebGPU** when the browser offers an adapter, and otherwise **WebAssembly** (SIMD, single-threaded, because the site isn't cross-origin isolated). If WebGPU can't load a model, the engine falls back to WebAssembly for all models.
- **Files.** `pnpm vision:fetch` (`scripts/fetch-vision-assets.ts`) puts everything into `public/vision/` (git-ignored). It runs automatically before `pnpm dev` and `pnpm build`.
  - The models are downloaded from Hugging Face and checked.
  - The runtime's `.wasm`/`.mjs` files are copied from `node_modules`.
  - Paths contain the version or hash, and `next.config.ts` serves `/vision/*` with `Cache-Control: immutable`.
- **Download size for a customer, once:** the WebAssembly runtime is 3.7 MB compressed (the WebGPU build is about 7 MB), plus the models at 9.7 MB. Browsers request nothing from third parties (an E2E test checks this).

## Code

| File | Role |
|---|---|
| `lib/vision/geometry.ts` | Letterboxing frames into the models' square inputs and mapping points back |
| `lib/vision/movenet.ts`, `yunet.ts`, `segment.ts` | Each model's input layout and output decoding (pure, unit-tested) |
| `lib/vision/smooth.ts` | One Euro filter for keypoints |
| `lib/vision/engine.ts` | Loads the models and runs them on a frame (OffscreenCanvas → tensors → decoded results) |
| `lib/vision/vision.worker.ts`, `protocol.ts`, `client.ts` | The worker thread and the page's handle on it; frames go in as transferred `ImageBitmap`s |
| `lib/vision/photo-check.ts` | Try-on photo rules shared by the browser and the worker |
| `lib/vision/check-photo.ts` | The browser's check before upload |
| `lib/vision/node-vision.ts` | The same models in Node, for the worker (`LocalPhotoChecker`) |
| `app/(shop)/mirror/check/` | **`/mirror/check`**: the speed and accuracy check (camera or a photo from the device; not linked from the shop) |

## Measurements

These were taken on 2026-10-29 on the Mac mini, with Chromium headless, **WebAssembly only (no GPU)**:

| | Body | Outline | Face |
|---|---|---|---|
| Per run | 27–54 ms | 28–38 ms | 126–136 ms |

- **Live camera: 18 frames a second.** The body runs on every frame, the outline on every 2nd and the face on every 10th.
- Node (WebAssembly) gave similar times.
- WebGPU in a normal Chrome or Safari should be faster. Measure on real devices with `/mirror/check`.
- **Phones:** the camera only works on secure pages. `localhost` counts as secure; `http://<computer-ip>:3002` from a phone does not, so phone tests need HTTPS (e.g. a tunnel, or `next dev --experimental-https`).
- The models were checked on the Spaces' example photos. Joints, the face box and the outline all landed correctly; a face cut off by the frame isn't found (as expected).
