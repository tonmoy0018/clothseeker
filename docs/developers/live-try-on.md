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
  - **Cleaned up for wearing** (`lib/vision/garment-fill.ts`, shop items):
    - `recoverGarment` adds the coloured parts the garment finder misses because they aren't the main colour: a pale placket, an embroidered collar band, embroidery, a print's motifs on a skirt's edge (down to the hem; otherwise they'd leave bites in it). It grows only into clearly coloured pixels, so a mannequin's neck, shadows and the backdrop stay out.
    - Notches about 1% of the picture wide are sealed, and pixels at the edge with the backdrop's colour take the fabric's colour (`recolourBackdrop`).
    - The measurements (shoulders, waist, sleeves) still come from the plain cut-out, so a collar is never taken for the shoulders.
  - **Pieces:** the body and each sleeve. Only edges against the backdrop are softened, after dropping their outermost pixel ring (a pale fringe). Joins between pieces stay hard, and sleeves overlap the body by 2 px, so no background shows through.
  - **Long sleeves stay whole** (`withLooseSleeves`): sleeve parts the finder left in the body, either cut off from the torso or hanging beside it with a gap, are added to the sleeve down to the cuff (a panjabi's forearms).
- **Fitting** (`lib/vision/mirror.ts`, pure and unit-tested in `mirror.test.ts` and `mirror-fit.test.ts`). Everything is in the camera's own coordinates, where, as in a catalogue photo, the person's left is on the picture's right; the canvas is shown flipped with CSS.
  - **Shoulders:**
    - The garment hangs from its shoulder seams. When its top is a collar standing up near the centre line, the seams are measured just inside the shoulder points, and the collar stands above them around the neck.
    - The seams are pinned 14% of the shoulder-joint distance above the joints (`SHOULDER_LIFT`), at 1.1× their width (`SEAM_PER_JOINTS`).
    - Mannequin shoulders slope far more than people's, so 55% of the garment's measured shoulder slope is taken out (`SHOULDER_SQUARE`). The raise peaks at the shoulder point and eases off over the sleeve top, so the shoulder stays round.
  - **Waist and below:** the waist goes to the body's waist (60% of the way to the hip joints, `BODY_WAIST`). Below it the garment hangs towards the knees and 35% straight down (`GRAVITY`), so a skirt hangs when the body leans.
  - **Fitted to the person's outline** (`measureOutline`, `fitToOutline`): on 25 rows, the person mask gives how far the body reaches on each side of the centre line. The mask is moved along with the body on frames where the outline model doesn't run.
    - Above the hips, the body ends where the mask does or where an arm begins. The garment follows it with 6% ease (`EASE`), between 0.85× and 1.4× its own width (`MIN_FIT`, `MAX_WIDEN`). So it wraps a slimmer or fuller figure, and when the person turns, the far side narrows more than the near side.
    - Below the hips it reaches the furthest leg (hands left out) and only ever widens, so a skirt covers legs that step apart.
    - The shoulders keep the garment's own width; the fitted width takes over across the upper chest.
    - Widths are smoothed between rows and over frames (`WidthSmoother`). Without a mask yet, the garment widens to an arm hanging beside it instead (as before).
  - **Cloth moves** (`lib/vision/cloth.ts`, `ClothSway`): the hem behaves like a weight on a damped spring from the hips (1.3 Hz, damping 0.3). When the person moves, it trails behind, swings past and settles. The swing grows from nothing at the hips to its most at the hem, and is capped at 45% of the shoulder width.
  - **Drawing:** an 8×24 mesh of affine triangles (`drawMesh` in `lib/vision/draw.ts`). The columns meet at the centre line, because each side is fitted on its own. Each triangle is grown by 1.3 px, so their edges overlap and no hairlines show. Facing away hides the garment with a hint.
- **The person's own clothes where the garment doesn't cover them** (`lib/vision/uncover.ts`, `FrameCleaner` in `draw.ts`). For example, a T-shirt's sleeves around a sleeveless dress, or its neckline inside a low one. Before the garment is drawn, a smaller copy of the frame is cleaned (the shoulders about 60 px apart, at most 480 px wide; about 5 ms):
  - **Skin colour** is read around the nose (`skinModel`), and settles over frames. The paint itself takes the colour of the person's visible neck and arm skin, which is usually darker than a lit face.
  - **On the shoulders, upper chest and arms**, clothing becomes skin:
    - the shoulders slope from the neck;
    - arms are 26% of the shoulder distance wide (`ARM_HALF`);
    - the skin is shaded by the cloth's light and folds and darkens towards the outline and the arms' sides.
  - **Outside the bare body**, such as a sleeve standing off the arm or a band at the outline (`STAND_OFF`), clothing becomes the backdrop beside it on the same row.
  - **Left alone:**
    - the head;
    - dark hair near it;
    - real skin, including its shadows (an elliptical tint test, `skinDistance`; borderline tints are only partly painted);
    - the backdrop;
    - forearms' shaded edges;
    - everything below the upper chest (the garment covers the torso, and painting there would show a bare torso wherever a garment doesn't reach); the paint fades out over a short band;
    - everything below the hips (trousers under a short dress stay).
- **Sleeves follow the arms** (`sleeveFits`, `sleeveMesh`):
  - Real sleeves are split from the garment picture: sleeve-mask pixels outside the torso trunk (`SLEEVE_TRUNK`) that leave the shoulder outwards or downwards. Straps stay with the body.
  - Each sleeve is bent along shoulder → elbow → wrist. At the shoulder it is mapped exactly like the body, so the cap continues the shoulder line. It turns to follow the arm over the first 25% of its length (`SLEEVE_BLEND`).
  - It's compressed so it never reaches past the wrist.
- **Arms in front:** the parts of the arms the garment doesn't cover are drawn back from the cleaned camera frame over the garment, masked by the person outline (`exposedArm`, `PersonLayer.drawArms`). That's below a short sleeve, the hand below a long one, or almost the whole arm for a sleeveless garment. The stroke is about an arm wide (`ARM_WIDTH`, 21% of the shoulder distance); wider would redraw the person's own clothes beside the arm.
- **Looks worn, not pasted** (`GarmentCompositor`, `lib/vision/relight.ts`):
  - The garment pieces are drawn into their own layer.
  - That layer is relit from the camera with a soft-light "shade" picture made from a 240-px copy of the frame. It carries the creases of the clothes underneath (fine ÷ broad brightness), the room's light falling across the body, and a mild colour cast. Both are kept gentle (0.82–1.2 and 0.88–1.15), so the colours and edges of the person's own clothes (dark trousers under a shirt's hem) don't read as shadows.
  - Its edges are darkened softly inside its outline (`roundEdges`, 45%), as cloth turning away from the camera round the body is.
  - The layer is then laid on the frame with a soft contact shadow.
  - Cut-out edges are feathered (`featherAlpha`).
- **Hints** appear when the shoulders and hips aren't in view, or the person faces away.
- **Take photo** shows the mirrored picture with the garment:
  - **Save picture** downloads it.
  - **Use for the realistic try-on** passes the plain camera frame, cropped to a 3:4 portrait around the person, to the try-on panel. There it's offered as "Use my photo from the live mirror", only after consent, and goes through the usual on-device check and upload.
- **Tests:**
  - `tests/unit/mirror.test.ts` and `mirror-fit.test.ts`: the fitting.
  - `tests/unit/mirror-drape.test.ts`: the outline fit, turning, legs, the swing, gravity, and hiding the person's own clothes.
  - `tests/e2e/live-mirror.spec.ts` (`@supabase`): Chromium's fake camera plays `tests/fixtures/mirror-woman.mjpeg` (an AI-generated person). It checks that the body is found, a photo is taken and handed to the try-on, nothing goes to another site, and "Make it real" works only after consent.

### Make it real

The mirror is instant but 2D. **Make it real** (beside "Take photo", when the mirror is opened from a product page or the design screen) turns the customer's current pose into the realistic AI try-on, in a panel inside the mirror, without leaving it:

1. Signed-out visitors are sent to sign in. The first time, the panel shows the try-on consent points (`TRYON_CONSENT_POINTS`) and nothing is captured until the customer ticks "I agree".
2. The current camera frame is cropped to a 3:4 portrait around the person and checked on the device (`photoProblemOnDevice`); a problem is shown with its reason and nothing is uploaded.
3. The photo is downscaled and uploaded with consent (`uploadTryOnPhotoAction`), then the usual try-on job starts (`startTryOnAction`, same 5-a-day limit and cache) and is polled every 2 s.
4. The result appears in the panel, with how many try-ons are left today. "Back to live" returns to the mirror.

It's a delay of about 25–60 s with the free IDM-VTON Spaces (instant with the fake provider), not live video. The photo is an ordinary try-on photo: private, deleted after 24 h unless saved.

### Limits

- **A 2D fit, not a photo:** the garment is fitted onto the body, moved and relit, but it isn't regenerated.
  - Uncovered clothes become painted skin or backdrop: convincing at a glance, flat up close. Clothes the same colour as the skin or the backdrop, or black clothes next to black hair, stay as they are. A busy backdrop shows the row-copied fill.
  - Below the upper chest, the customer's own clothes still show where a garment doesn't cover the torso (deliberately: no painted bare torso).
  - Hair isn't drawn in front.
  - Garments photographed from the side (the Off-Shoulder Evening Dress's catalogue photo is a three-quarter view) can't sit square on a person facing the camera.
  - Some catalogue photos leave a small gap at one shoulder that shows close to the camera (the Linen Casual Shirt).
  - Strongly sloped shoulders can leave a slight corner where the shoulder meets the sleeve.
  - The realistic photo is "Make it real" (the AI try-on). Photo-real live video would need a generative real-time model (e.g. Decart's Lucy VTON, paid per second).
- **Checked framings (2026-11-01):** close-up (head to chest, hips out of view) and mid-shot (head to thighs) of an AI-generated man in the Linen Casual Shirt, Oxford Shirt and Embroidered Eid Panjabi, and the full-length test woman (in a T-shirt and leggings) in eight dresses, standing and stepping side to side.
- **Cut-out quality:** pale or brightly lit garments can lose pieces in the cut-out (e.g. the smocked dress's left side), and the mirror shows those gaps.
- **The camera needs a secure page:** `localhost` works; a phone on the local network needs HTTPS.
- **Distance:** one person, about 1–4 m from the camera, facing it.
