# Live try-on: on-device vision

The live mirror (camera) and the try-on photo checks find the customer's body and face **in their own browser**. Nothing is uploaded for this: the models are downloaded once from our own site and run in a Web Worker. The realistic AI photo try-on ([try-on.md](try-on.md)) is separate.

Status: **all three steps are done**:
1. models, runtime and the speed check;
2. try-on photo checks on the device and in the worker ([try-on.md](try-on.md#photo-checks));
3. the live mirror, with the real garment drawn on the customer (below).

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

## The live mirror

"Live mirror" appears on product pages that have a try-on picture and on the design screen (tool rail). It opens a full-screen view (`app/(shop)/live-mirror.tsx`, rendered into `document.body`).

- **The camera starts only after "Start camera".** The notice says the camera stays on the device and nothing is recorded or uploaded. Frames go to the vision worker in the same tab: the body runs on every frame, the outline on every 2nd.
- **The garment picture** (`lib/vision/garment-source.ts`), prepared in the browser:
  - **Shop item:** its try-on picture (the first catalogue photo), cut out with the same code as the server (`findGarment`/`splitGarment` in `lib/garment-photo/segment.ts`). Storage answers with `Access-Control-Allow-Origin: *`, so the browser may read the pixels.
  - **Design:** the design screen's recoloured front picture with its printed items, cut out by the union of the picture's region masks.
- **Fitting** (`lib/vision/mirror.ts`, pure and unit-tested). Everything is in the camera's own coordinates, where, as in a catalogue photo, the person's left is on the picture's right; the canvas is shown flipped with CSS.
  - The garment's shoulder line is pinned 16% of the shoulder-joint distance above the shoulder joints (`SHOULDER_LIFT`), at 1.2× their width (`SEAM_PER_JOINTS`).
  - Its waist goes to the body's waist (60% of the way to the hip joints, `BODY_WAIST`); below the waist it hangs along hips→knees.
  - It is drawn as a 6×16 mesh of affine triangles (`drawMesh` in `lib/vision/draw.ts`). Turning narrows it; facing away hides it with a hint.
- **Sleeves follow the arms** (`sleeveFits`, `sleeveMesh`):
  - Real sleeves are split from the garment picture: sleeve-mask pixels outside the torso trunk (`SLEEVE_TRUNK`) that leave the shoulder outwards or downwards. Straps stay with the body.
  - Each sleeve is bent along shoulder → elbow → wrist, joined to the torso where the body mesh puts its root.
  - It's compressed so it never reaches past the wrist.
- **Arms in front:** the parts of the arms the garment doesn't cover are drawn back from the camera frame over the garment, masked by the person outline (`exposedArm`, `PersonLayer.drawArms`). That's below a short sleeve, the hand below a long one, or almost the whole arm for a sleeveless garment.
- **Looks worn, not pasted** (`GarmentCompositor`, `lib/vision/relight.ts`):
  - The garment pieces are drawn into their own layer.
  - That layer is relit from the camera with a soft-light "shade" picture made from a 240-px copy of the frame. It carries the creases of the clothes underneath (fine ÷ broad brightness), the room's light falling across the body, and a mild colour cast.
  - The layer is then laid on the frame with a soft contact shadow.
  - Cut-out edges are feathered (`featherAlpha`).
- **Hints** appear when the shoulders and hips aren't in view, or the person faces away.
- **Take photo** shows the mirrored picture with the garment:
  - **Save picture** downloads it.
  - **Use for the realistic try-on** passes the plain camera frame, cropped to a 3:4 portrait around the person, to the try-on panel. There it's offered as "Use my photo from the live mirror", only after consent, and goes through the usual on-device check and upload.
- **Tests:**
  - `tests/unit/mirror.test.ts`: the fitting.
  - `tests/e2e/live-mirror.spec.ts` (`@supabase`): Chromium's fake camera plays `tests/fixtures/mirror-woman.mjpeg` (an AI-generated person). It checks that the body is found, a photo is taken and handed to the try-on, nothing goes to another site, and "Make it real" works only after consent.

### Make it real

The mirror is instant but 2D. **Make it real** (beside "Take photo", when the mirror is opened from a product page or the design screen) turns the customer's current pose into the realistic AI try-on, in a panel inside the mirror, without leaving it:

1. Signed-out visitors are sent to sign in. The first time, the panel shows the try-on consent points (`TRYON_CONSENT_POINTS`) and nothing is captured until the customer ticks "I agree".
2. The current camera frame is cropped to a 3:4 portrait around the person and checked on the device (`photoProblemOnDevice`); a problem is shown with its reason and nothing is uploaded.
3. The photo is downscaled and uploaded with consent (`uploadTryOnPhotoAction`), then the usual try-on job starts (`startTryOnAction`, same 5-a-day limit and cache) and is polled every 2 s.
4. The result appears in the panel, with how many try-ons are left today. "Back to live" returns to the mirror.

It's a delay of about 25–60 s with the free IDM-VTON Spaces (instant with the fake provider), not live video. The photo is an ordinary try-on photo: private, deleted after 24 h unless saved.

### Limits

- **A 2D fit guide, not a photo:** the garment is stretched onto the body's outline and relit, but it isn't regenerated. The customer's own clothes can show around a slimmer garment (e.g. a T-shirt's sleeves around a sleeveless dress), and hair isn't drawn in front. Sleeves hanging very close to a mannequin's body may not be recognised (the Embroidered Eid Panjabi's cuffs). The realistic photo is the AI try-on; a generative real-time model (e.g. Decart's Lucy VTON, paid per second) would be needed for photo-real live video.
- **Cut-out quality:** pale or brightly lit garments can lose pieces in the cut-out (e.g. the smocked dress's left side), and the mirror shows those gaps.
- **The camera needs a secure page:** `localhost` works; a phone on the local network needs HTTPS.
- **Distance:** one person, about 1–4 m from the camera, facing it.
