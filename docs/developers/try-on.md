# Virtual try-on

Customers can see a dress on a photo of themselves. It's available on the design screen as the **Try on** button in the bar pinned to the bottom (always in view, beside Save; also the shirt icon beside the preview), which opens "See it on me" under the picture and uses the design as currently edited, and as "Try on" on product pages (it uses the ready-made dress). It is **optional** and **labelled as a rough AI preview**. The live mirror's **Make it real** uses the same flow with a photo of the customer's current pose ([live-try-on.md](live-try-on.md#make-it-real)).

```
browser: consent ✓ → upload photo ──▶ uploadTryOnPhoto (lib/tryon/service.ts)
                                        re-encode (no metadata) · shape/light check · tryon-private/{customer}/photos/
browser: Try it on ──▶ createTryOnJob ── owner checks · 5/day quota · cache ──▶ ai_jobs (TRY_ON)
worker:  runTryOn (lib/ai/worker/try-on.ts)
           1. photo check once per photo (PlannerProvider.checkTryOnPhoto)
           2. garment: renderFlatGarment(design) or the dress's photo/template garment → white 3:4 canvas
           3. TryOnProvider.tryOn → re-encode → tryon-private/{customer}/results/
           4. one transaction: try_on_results row + job SUCCEEDED (under the lease)
browser: polls getTryOnStatus → before / after
worker sweep: cleanupTryOnMedia — unsaved photos/results older than 24 h
```

## Consent and privacy

- **No upload without consent.** The panel lists what happens to the photo (`TRYON_CONSENT_POINTS` in `lib/tryon/rules.ts`):
  - it is used only for the preview
  - it is checked for quality on the customer's device and on our worker, and isn't sent anywhere for that
  - it is processed by an AI try-on model, on ClothSeeker's own computer (`local`) or at a third-party service (a public Hugging Face Space, `huggingface`)
  - it is never used to train AI
  - it is deleted after 24 hours unless saved
- The upload control stays disabled until the box is ticked. The server refuses any upload whose `consent` isn't exactly `"yes"` (tested), and stores `consentAt` on each photo.
- **Uploads** may be any size: the browser shrinks big photos to at most 2000 px and compresses them under the upload limit (`downscalePhoto`), and the server enlarges small ones to 768 px on the shorter side. They're re-encoded to WebP by `processImage("tryOnPhoto")`, which strips EXIF/GPS. They go in the private `tryon-private` bucket, and browsers only get short-lived signed URLs.
- **From the live mirror:** a photo taken there can be offered to the panel ("Use my photo from the live mirror"). It still needs the consent box and goes through the same checks and upload ([live-try-on.md](live-try-on.md#the-live-mirror)).
- **Saving** is explicit: "Keep this photo" and "Keep this try-on". Everything else is deleted 24 hours after it was made.
- **Deleting a photo** ("Delete photo now") removes it and every try-on made from it immediately, and writes an `AuditLog` row (`tryon.photo_deleted`, ids and counts only).
- **The 24-hour cleanup** (`cleanupTryOnMedia`, run by the worker on every poll):
  - It removes the files first, then marks rows with `deletedAt`. Rows stay for the audit trail but no longer point at any file.
  - It's idempotent: it only touches rows not yet deleted.
  - Each run that deleted something writes one `tryon.cleanup` audit row (system actor, counts only). Tested.
- Try-on photos are never used for training by ClothSeeker. Worker logs contain ids and pass/fail flags only, never images.
- **With `TRYON_PROVIDER=local`** the photo never leaves the worker's machine: masking and the model both run there ([Local try-on](#local-try-on)).
- **Before real customers use the Hugging Face provider:** the photo goes to a public demo Space whose owner could see it. (Until 2026-10-29 Gemini also checked each try-on photo, which sent it to Google's free tier; the check now runs on-device, see below.) Use a private or paid endpoint, or keep `TRYON_PROVIDER=fake`, and say so in the privacy policy.

## Photo checks

**Any photo with a person in it can be used** (decided 2026-11-02): selfies, waist-up and half-body photos, landscape photos, side views, dim light and photos with other people in them. The garment goes on the main person and simply continues past the photo's edge. All checks use the same rules, `judgeTryOnPhoto` in [`lib/vision/photo-check.ts`](../../lib/vision/photo-check.ts), on the findings of the on-device body and face models ([live-try-on.md](live-try-on.md)):
- **refused only when no person is found:** both shoulders must be found somewhere in the picture ("We couldn't find you in this photo. Use one where your shoulders can be seen.");
- light, the number of faces and facing the camera are still measured (`goodLight`, `onePerson`, `facingForward`) and logged by the worker, but no longer refuse a photo.

1. **In the browser, before upload** (`photoProblemOnDevice`, `lib/vision/check-photo.ts`): the models run on the customer's device and an unusable photo is refused instantly with the exact reason ("We can't see you from your shoulders to your knees…"). Nothing is uploaded. If the models can't run on that device, the photo is uploaded and checked by the worker instead.
2. **At upload** (`photoShapeProblem`): only a practically all-black or all-white photo is refused; any orientation is fine.
3. **In the worker, once per photo** (`TryOnPhotoChecker`): the check customers can't skip. With `TRYON_PROVIDER=huggingface` it's `LocalPhotoChecker`, the same models run in Node on our own machine (about 0.3 s per photo); the worker refuses to start if `pnpm vision:fetch` hasn't run. With the fake try-on it's `FakePhotoChecker` (rejects dark or landscape photos). A failure ends the job with the specific message and doesn't count toward the limit. Passing sets `try_on_photos.checked_at`, so the photo isn't checked again.
- **Test photos:** `tests/fixtures/tryon-woman.jpg` and `tryon-man.jpg` are AI-generated (FLUX.1 schnell) people who don't exist, so they can be used in tests and screenshots. The real-model tests (`tests/unit/photo-check.test.ts`) check that they pass, that waist-up, darkened and two-person versions pass too, and that an empty photo is refused.

## Limits, cache and "Update try-on"

- **5 try-ons per customer per Dhaka day** (`TRYON_DAILY_LIMIT`), separate from the 10 AI design rounds, because the free GPU time is shared by the whole store. It's enforced under the same per-customer advisory lock.
- **Cache:** same photo + same garment ⇒ the earlier result, with no provider call and no limit used. The garment is identified by `designSignature(spec)`, which covers colours, patterns, style options and layers but not size, or by `productSignature`.
- **After a design edit**, the panel says "Your design changed since this try-on" (`isTryOnStale`). **Only the "Update try-on" button reruns it. Nothing reruns automatically** (tested in E2E: no new job, limit unchanged).

## Providers

| `TRYON_PROVIDER` | What | When |
|---|---|---|
| `fake` (default) | `FakeTryOn` lays the garment over the middle of the photo. Deterministic, instant, nothing leaves the machine. | Development, tests, CI |
| `huggingface` | `HuggingFaceTryOn` (`lib/ai/tryon-hf.ts`) calls free public Gradio Spaces with `@gradio/client`, in the order of `TRYON_SPACES` | Real previews |
| `local` | `LocalTryOn` (`lib/ai/tryon-local.ts`): CatVTON on the worker's own machine ([below](#local-try-on)). Photos stay here, no daily GPU allowance; about 2–2.5 minutes per try-on on an 8 GB M1 | Real previews, private |

**Spaces and their dress modes** (default order, best first):
- `jallenjia/Change-Clothes-AI` (IDM-VTON with a dress mode) uses `/tryon` with `category: "dresses"` or `"upper_body"`, the person photo as the editor's background and automatic masking (`is_checked: true`).
- `yisol/IDM-VTON` (the official Space) uses the same `/tryon`, but **tops only**: dresses skip it (`categories` in `TRYON_SPACES`), because it would turn them into tops.
- `levihsu/OOTDiffusion` uses `/process_dc` with `category: "Dress"`.
- `franciszzj/Leffa` uses `/leffa_predict_vt` with `vt_model_type: "dress_code"` and `vt_garment_type: "dresses"`.

**Garment preparation.** Each garment is cropped and centred on a white 768×1024 canvas (`prepareGarment`). For designs this is the flat garment from `renderFlatGarment`; for ready-made dresses it's the first product photo, or else the template's garment image (`productTryOnImageKey`), with the dress cut out of it first (`cutOutGarment` in `lib/garment-photo/align.ts`: no mannequin, stand or backdrop; the whole photo if no dress is found). For photo templates the flat garment is already cut out by the region masks. "Try on" is hidden on dresses that have neither.

**Garment description.** IDM-VTON also reads a text, `garment_des`, as "model is wearing …". Without it the model guesses the cut and often draws the wrong length or sleeves. `garmentDescription` (`lib/tryon/describe.ts`, pure and unit-tested) builds it, at most 120 characters, **only from catalogue words, never from text a customer typed**:
- designs: the main colour's name, the product name and each chosen style (`stylePhrase`: "v-neck neckline", "short sleeves", "sleeveless", "midi length"), e.g. "a navy linen wrap dress, v-neck neckline, short sleeves";
- ready-made items: the product name and the first sentence of the team's description.

The other Spaces have no text input and ignore it. The cache key is `v: 4` since descriptions were added and `v: 5` since the local try-on, so older results are redone.

**Failures:**
- A space that errors or sleeps → the next space is tried.
- Every space over its free GPU quota → `TRYON_LIMIT`, not retried ("Our free try-on service has reached its limit for today").
- Anything else → retried by the job runner (2 retries with backoff).
- Each attempt is limited by `TRYON_TIMEOUT_MS` (default 240 s).
- Space error texts are never copied into our errors or logs, because they may echo inputs.

## Fit (height and the photo)

Decided 2026-11-02: customers type **only their height**, choose the size to try, and see **their size** and a **fit report** while the try-on **shows that size on them**. Their body measurements come from the try-on photo they chose. A first version also asked for weight and a Fitted / Regular / Relaxed preference. Both were dropped the same day: the photo replaces weight (migration `20261102130302_fit_height_only`), and someone who likes clothes looser or closer simply tries the next size, which the report describes (`20261102133344_fit_no_preference`). `lib/fit/fit.ts` and `lib/fit/measure.ts` are pure and shared by the browser and the worker.

- **Measuring** (`measurePhoto`, run in the browser by `lib/vision/measure-photo.ts` with the on-device pose and person-outline models; the photo is fetched from its signed URL and nothing is uploaded for this):
  - The body's height in pixels is taken from the top of the head (found in the outline above the nose) to the ankles when the whole person is in the photo. Otherwise it comes from the joints that are visible (shoulder → hip → knee → ankle) at standard proportions (`BODY_LEVELS`). The customer's height turns pixels into centimetres.
  - **Women:** the front width is measured at the bust (median over 25–40% of the shoulder-to-hip distance), the waist (the narrowest place over 50–85%) and the hips (the widest place over 95–125%).
  - **Men:** the chest and the waist (the narrowest place over 60–85%).
  - Arms hanging beside the body are cut off at the arm's inner edge (the arm and hand along the elbow and wrist points).
  - A girth is the front width × a typical body's girth/width ratio (`TYPICAL`: 160 cm women's 89/71/95 cm girths with 29/26/35 cm widths; 172 cm men's 97/83/39.5 with 32/30/12). A front photo can't see depth, so this ratio is assumed. The typical widths were checked against our AI-generated test people, not against tape-measured people.
  - **Guessed, not measured** (`estimated`, marked * in the report, counting half when choosing a size): a men's neck, and a waist that is as wide as the bust in the outline (≥ 0.97 for women, ≥ 1.03 for men). That is a loose top hanging straight down, not the body. Guesses use a typical body's proportions from the bust (chest) and hips.
  - **No measurements** (the report shows only the length, and says why, `MEASURE_PROBLEM_TEXT`):
    - no shoulders;
    - hips not in the photo, or the photo ending before the hips' widest point;
    - turned sideways or leaning (shoulders narrower than 0.55 × the torso length, or hips off to the side);
    - widths no body has (outside 0.65–1.8 × typical).
  - Loose clothes still make people look bigger, and the panel says so.
- **Your size** (`fitReport`): among the sizes on sale, the one whose size-chart range ([size-chart.ts](../../lib/catalog/size-chart.ts)) puts the body nearest its middle. A size that would be tight is penalised three times as much as a loose one. Every seed item comes in XS–XXL. The report lists, per measurement, the body, the size's range, and "fits", "tight by N cm" or "loose by N cm".
- **Length** (`hemPlace`): garment lengths are measured from the high point of the shoulder, on size M, and graded ±1.5 cm per size (`gradedLength`).
  - Designs use their length option (`STYLE_LENGTH_CM`: mini 85, knee 100, midi 115, maxi 140, hip 78, long 112).
  - Ready-made items use `Product.lengthCm`, which the team enters in the product form (seeded from the catalogue photos), or nothing.
  - With standard body proportions (`BODY_LEVELS`), the hem is described as "at the knee", "6 cm below the knee", "on the floor"… This needs only the height, so it shows even when the photo couldn't be measured.
- **The picture** (local try-on only):
  - **What the job carries:** `fit` (height, size, and `girthsCm` from the browser or null). It's part of the cache key, so a new size, height or photo measurement is a new try-on. The girths are the customer's own, measured on their device; they only shape their own preview and are bounds-checked (20–250 cm, exactly 3).
  - **What the worker does:** it turns the fit into `widthFactor` (the size's middle against the bust/chest: 1 = made for them or not measured, up to 1.3 loose, down to 0.85 tight) and the hem level.
  - **What `LocalTryOn` does:** it widens or narrows the garment picture (a wider garment is drawn looser, tested), lets the mask stand further off the body for a size too big (never closer for a size too small: a tight size doesn't make anyone slimmer), and ends the mask at the hem.
  - **Below the hem the photo is kept** (their own legs or legwear). When we repainted the legs alone, the model drew trousers.
  - The Hugging Face provider ignores the fit; the report still shows.
- **Remembering** (`lib/fit/profile.ts`, `body_profiles`): only when the customer ticks "Remember my height on my account". "Forget it" deletes it, and it goes with the account. Measurements from photos are never stored on the account. A result's `fit` is cleared when the result is deleted (by the customer or the 24-hour cleanup). Height and measurements are never logged.
- **The panel** (`app/(shop)/fit-section.tsx`): an optional section above "Try it on".
  - Each photo is measured once, when it's first chosen.
  - With no size chosen, the try-on uses the recommended one.
  - A result shows "Showing size M at 165 cm.", or "… (length only)" when the photo wasn't measured.
  - Changing the size, height or photo offers "Update try-on" (it never reruns by itself).

## Local try-on

`TRYON_PROVIDER=local` runs the try-on on the worker's machine instead of a public Space. Set it up once with `pnpm tryon:setup` (`scripts/setup-local-tryon.ts`):
- a Python 3.11 virtual environment with pinned packages (`LOCAL_TRYON_PACKAGES`), made with `uv` if installed;
- the models from Hugging Face at **pinned commits**, each checked by **SHA-256** (`LOCAL_TRYON_FILES` in `lib/ai/tryon-local-setup.ts`), **safetensors and JSON only** (no pickles): Stable Diffusion 1.5 inpainting's UNet (fp16), the `sd-vae-ft-mse` image encoder/decoder, and CatVTON's **DressCode** attention weights;
- about 2.3 GB in `~/.cache/clothseeker/local-tryon` (`LOCAL_TRYON_DIR`), outside the iCloud-synced project. It writes `verified.json` last; the worker refuses to start with `TRYON_PROVIDER=local` until it's there and every file has its size.

**How a try-on runs** (`LocalTryOn.tryOn`):
1. **The mask** (`tryOnMask`, `lib/tryon/mask.ts`, pure and unit-tested): only the shoulders are needed; hips, knees and ankles out of the picture are guessed below it, and a sideways stance keeps a body-wide mask (the width is never below what the head height or torso suggests). From the on-device pose and person mask (`NodeVision`, also used for the photo check), the area to repaint is the lower neck down to where the garment reaches (`GARMENT_TYPES[type].tryOnReach`: shirts below the hips, panjabis to the knees, dresses to the ankles), plus both arms down to just above the wrists (sleeves may change) and any of the person's own clothes sticking out further.
   - **The body keeps its shape** (2026-11-02): above the hips, and for shirts all the way down, the mask stays within 6% of the shoulder width (`BODY_MARGIN`) of the person's outline. So the model can't draw shoulders, sides or arms wider than they are. Below the hips a skirt may stand away from the legs.
   - **Kept as they are:**
     - the face, hands, feet and backdrop;
     - the wrists, with bracelets or a watch, but only hands that are in sight (`visibleHands`, `lib/tryon/hands.ts`: skin like the face's, by hue and colourfulness, where the hand would be). A hand in a pocket isn't kept: its spot was the old pocket and came out as a black "glove". Repainted, the model draws the arm going into the trouser pocket under the new garment;
     - hair falling over the shoulders, when it can be told apart (`hairMask` in `lib/tryon/hair.ts`). There is no hair model on the device, so hair is found by shade: much darker than the lit face, growing from the head. When hair isn't much darker than the skin, or the growth spills into the neck or chest (shadowed dark skin, a dark top), nothing is kept and the hair is repainted as before.
   - **Not solved:**
     - Arms inside the mask can still be moved by the model, for example drawn closer to the body.
     - Necklaces under the new neckline are lost.
     - We tried keeping bare arms past the sleeves, or showing them to the model. On a seated photo with the arms resting on the lap, the model then drew two garments (a crop top over a denim skirt). On a standing photo, the sleeves came out cut off. So both were dropped.
2. **A 3:4 crop around the person** (`tryOnCrop`): the smallest 3:4 box holding the whole person (from the person outline, head to feet) and the mask, with 8% room. It's at least the model's width (384 px) and never larger than the photo. It's written with the mask and the garment to a private temporary folder, deleted afterwards. Until 2026-11-08 the crop was the largest 3:4 box of the photo: a small figure in a landscape then got a few dozen of the model's pixels, and the shirt came out blurred and generic. Cropped to the person, the same photo gave the Oxford's button-down collar, buttons and cuffs.
3. **The model** (`worker/local-tryon/catvton_server.py`): one Python process, started on the first try-on and kept loaded (`CatVtonProcess`), one try-on at a time over stdin/stdout JSON lines. It stops after 10 idle minutes to give the memory back, and is killed when a try-on runs out of time. It gets only `PATH`, `HOME` and its own settings (never the worker's keys), runs offline (`HF_HUB_OFFLINE`), and its output never reaches our logs.
4. **Back into the photo** (`blendTryOn`): only the softened mask area takes the model's picture, so the face, hands and background keep the photo's full sharpness.

**Speed and memory on the Mac mini (8 GB M1, 2026-11-02):** about 2–2.5 minutes per try-on at 384×512 with 30 steps (`LOCAL_TRYON_STEPS`, `LOCAL_TRYON_WIDTH`), plus about 20 s to load the model the first time. To fit next to the Supabase stacks (OrbStack keeps 4 GB), the server:
- caps the GPU's share of memory (`PYTORCH_MPS_HIGH_WATERMARK_RATIO` 0.55);
- runs attention one head at a time, with float32 scores (half-precision scores overflow and give a black picture);
- runs the two guidance passes one after the other;
- runs the image encoder/decoder on the CPU (on the GPU it needs over 1 GB of scratch).

Without these it swapped and took over a minute per step.

**Quality (tested on the AI-generated test woman in a T-shirt and leggings):** the smocked dress (square neckline, smocked bodice, puff sleeves, maxi length, mint) and the strapless floral maxi came out as a photo of her wearing them, with bare arms where the garment has none. CatVTON's "mix" weights (trained at 1024 px) drew garbage on the forearms at this size; the DressCode weights, trained at 512×384, don't. Limits: the garment is re-drawn at 384×512 and scaled up, so fine prints and smocking are softer than the face around them; notches in a catalogue cut-out show at the hem.

**Licence:** CatVTON's weights are **CC BY-NC-SA 4.0, non-commercial**. Fine for this academic project; license or replace them before any commercial launch ([licences.md](licences.md)).

## Feasibility results (2026-10-09, `ai-scripts/tryon-feasibility.ts`)

`pnpm tsx ai-scripts/tryon-feasibility.ts <person> <garment> <out-dir> [--upper] [space…]` sends one photo and one garment to each Space and saves the outputs. Use photos you may share with a third party, e.g. the Spaces' own examples.

- Both Spaces were **running and answered in 17–26 s**, including through the app.
- **Quality is a rough preview.** OOTDiffusion clearly showed our dress (colours, bodice/skirt split, pattern) on the person. It also often invented extra garments where the original sleeves were (e.g. a dark "jacket" over the arms). Leffa, given a loose drawing, kept the person's own clothes and pasted the pattern on. Tight garment images (`prepareGarment`) helped noticeably. Re-tested on 2026-10-23 with cut-out catalogue photos: OOTDiffusion put the smocked dress (puff sleeves, smocked bodice, midi skirt) convincingly on the Space's example model in about 30 s; Leffa treated it as a top. The cache key includes a version (`v: 2` since the cut-out), so older results are redone.
- **The free GPU allowance is tiny.** Anonymous ZeroGPU use allowed **one** Leffa run (180 s of GPU reserved per call) before "You have exceeded your ZeroGPU quota… try again in 23:58". The allowance belongs to the worker, i.e. **all customers share it**. A free Hugging Face account token (`HF_TOKEN`) raises it somewhat; a paid plan or a self-hosted model is needed for real traffic.
- **Re-tested on 2026-10-26 after poor customer results** (a shirt came out as a garbled dark top with an invented belt, from OOTDiffusion). With the Spaces' own example models:
  - **IDM-VTON is far better.** It put the linen shirt (collar, buttons, pocket, short sleeves) and the smocked dress (smocked bodice, puff sleeves, square neckline, colour) on the person realistically in about 25–30 s, so the two IDM-VTON Spaces now come first (cache key `v: 3`).
  - **Limits:** the result follows the shape of what the person is wearing: a dress tried on someone in trousers came out as a jumpsuit, and on someone in a knee-length dress it came out knee-length. Pale or brightly lit garments can lose a sliver at the shoulder in the cut-out, which shows as a small white patch.
  - `zhengchong/CatVTON` and `xiaozaa/catvton-flux-try-on` were down (HTTP 503); `frogleo/AI-Clothes-Changer` had no GPU free; the anonymous ZeroGPU allowance ran out after about four runs across all Spaces.
- **Decision (with the product owner):** ship it as a clearly labelled rough preview, with a friendly message when the daily limit is reached. Fakes stay the default.

## Tests

- `tests/unit/try-on-rules.test.ts`:
  - consent values, staleness rules and upload photo checks
  - garment canvas, the fake check and the fake try-on
  - `HuggingFaceTryOn` against a mocked Gradio client: dress parameters, token, fallback, quota → `TRYON_LIMIT`, abort, and no leaking of Space errors
- `tests/unit/fit.test.ts`: height-only input, the size made for the body (never tight; guessed measurements count less), the per-measurement report, length-only without measurements, hem places, length grading and the width factor.
- `tests/unit/fit-measure.test.ts`: measuring a drawn person of known widths (full-length and from the joints), arms beside the body ignored, a waist hidden by a loose top and a men's neck guessed, and each reason a photo can't be measured.
- `tests/integration/fit-profile.test.ts`: remembering, updating and forgetting a profile, owner-only, refused for admins and impossible values, deleted with the account.
- `tests/unit/tryon-mask.test.ts`: the local try-on's mask (neck to hem, arms, hands, wrists and face kept, hugging the body's outline above the hips, room for a skirt, a loose size standing off the body and a tight one never cutting into it, own clothes, pixels marked to keep), the 3:4 crop and the blend.
- `tests/unit/tryon-hair.test.ts`: hair over the shoulders found on a drawn person; nothing kept when the hair is as light as the skin, or when a dark top or shadowed neck would be taken for hair.
- `tests/unit/tryon-local.test.ts`: `LocalTryOn` with a fake model (only the mask area changes, crop and settings, temporary files deleted, no body → refused); `CatVtonProcess` with a fake process (loaded once, keys never passed, failures mapped, killed on timeout and restarted, load timeout).
- `tests/integration/try-on.test.ts`:
  - consent, upload validation, design and product try-ons
  - cache, the daily limit, photo rejection, timeout → retry, `TRYON_LIMIT`
  - a photo deleted while waiting, and ownership
  - immediate deletion, and the idempotent, audited 24-hour cleanup
- `tests/e2e/try-on.spec.ts` (`@supabase`, worker with fakes): consent gate → upload → try-on → design edit shows "Update try-on" without rerunning → update → keep → delete; product-page try-on; signed-out visitors.
