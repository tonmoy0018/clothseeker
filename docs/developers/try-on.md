# Virtual try-on

Customers can see a dress on a photo of themselves. It's available as "See it on me" (the shirt button beside the preview) on the design screen (it uses the design as currently edited) and as "Try on" on product pages (it uses the ready-made dress). It is **optional** and **labelled as a rough AI preview**.

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
  - it is sent to a third-party AI service (a public Hugging Face Space)
  - it is never used to train AI
  - it is deleted after 24 hours unless saved
- The upload control stays disabled until the box is ticked. The server refuses any upload whose `consent` isn't exactly `"yes"` (tested), and stores `consentAt` on each photo.
- **Uploads** are re-encoded to WebP by `processImage("tryOnPhoto")`, which strips EXIF/GPS. They go in the private `tryon-private` bucket, and browsers only get short-lived signed URLs.
- **Saving** is explicit: "Keep this photo" and "Keep this try-on". Everything else is deleted 24 hours after it was made.
- **Deleting a photo** ("Delete photo now") removes it and every try-on made from it immediately, and writes an `AuditLog` row (`tryon.photo_deleted`, ids and counts only).
- **The 24-hour cleanup** (`cleanupTryOnMedia`, run by the worker on every poll):
  - It removes the files first, then marks rows with `deletedAt`. Rows stay for the audit trail but no longer point at any file.
  - It's idempotent: it only touches rows not yet deleted.
  - Each run that deleted something writes one `tryon.cleanup` audit row (system actor, counts only). Tested.
- Try-on photos are never used for training by ClothSeeker. Worker logs contain ids and pass/fail flags only, never images.
- **Before real customers use the Hugging Face provider:** the photo goes to a public demo Space whose owner could see it, and if Gemini checks the photo, to Gemini's free tier, which may use data to improve Google's products. Use a private or paid endpoint, or keep `TRYON_PROVIDER=fake`, and say so in the privacy policy.

## Photo checks

1. **At upload** (`photoShapeProblem`): portrait orientation, not too dark, not blown out. These are cheap and immediate.
2. **In the worker, once per photo** (`checkTryOnPhoto`): exactly one person, roughly facing the camera, good light, body visible from shoulders to knees. Gemini does this when `PLANNER_PROVIDER=gemini`; the fake rejects dark or landscape photos. A failure ends the job with a friendly `PHOTO_REJECTED` message and doesn't count toward the limit. Passing sets `try_on_photos.checked_at`, so the photo isn't checked again.

## Limits, cache and "Update try-on"

- **5 try-ons per customer per Dhaka day** (`TRYON_DAILY_LIMIT`), separate from the 10 AI design rounds, because the free GPU time is shared by the whole store. It's enforced under the same per-customer advisory lock.
- **Cache:** same photo + same garment ⇒ the earlier result, with no provider call and no limit used. The garment is identified by `designSignature(spec)`, which covers colours, patterns, style options and layers but not size, or by `productSignature`.
- **After a design edit**, the panel says "Your design changed since this try-on" (`isTryOnStale`). **Only the "Update try-on" button reruns it. Nothing reruns automatically** (tested in E2E: no new job, limit unchanged).

## Providers

| `TRYON_PROVIDER` | What | When |
|---|---|---|
| `fake` (default) | `FakeTryOn` lays the garment over the middle of the photo. Deterministic, instant, nothing leaves the machine. | Development, tests, CI |
| `huggingface` | `HuggingFaceTryOn` (`lib/ai/tryon-hf.ts`) calls free public Gradio Spaces with `@gradio/client`, in the order of `TRYON_SPACES` | Real previews |

**Spaces and their dress modes:**
- `levihsu/OOTDiffusion` uses `/process_dc` with `category: "Dress"`.
- `franciszzj/Leffa` uses `/leffa_predict_vt` with `vt_model_type: "dress_code"` and `vt_garment_type: "dresses"`.

**Garment preparation.** Each garment is cropped and centred on a white 768×1024 canvas (`prepareGarment`). For designs this is the flat garment from `renderFlatGarment`; for ready-made dresses it's the first product photo, or else the template's garment image (`productTryOnImageKey`). "Try on" is hidden on dresses that have neither.

**Failures:**
- A space that errors or sleeps → the next space is tried.
- Every space over its free GPU quota → `TRYON_LIMIT`, not retried ("Our free try-on service has reached its limit for today").
- Anything else → retried by the job runner (2 retries with backoff).
- Each attempt is limited by `TRYON_TIMEOUT_MS` (default 240 s).
- Space error texts are never copied into our errors or logs, because they may echo inputs.

## Feasibility results (2026-10-09, `ai-scripts/tryon-feasibility.ts`)

`pnpm tsx ai-scripts/tryon-feasibility.ts <person> <garment> <out-dir> [space…]` sends one photo and one garment to each Space and saves the outputs. Use photos you may share with a third party, e.g. the Spaces' own examples.

- Both Spaces were **running and answered in 17–26 s**, including through the app.
- **Quality is a rough preview.** OOTDiffusion clearly showed our dress (colours, bodice/skirt split, pattern) on the person. It also often invented extra garments where the original sleeves were (e.g. a dark "jacket" over the arms). Leffa, given a loose drawing, kept the person's own clothes and pasted the pattern on. Tight garment images (`prepareGarment`) helped noticeably.
- **The free GPU allowance is tiny.** Anonymous ZeroGPU use allowed **one** Leffa run (180 s of GPU reserved per call) before "You have exceeded your ZeroGPU quota… try again in 23:58". The allowance belongs to the worker, i.e. **all customers share it**. A free Hugging Face account token (`HF_TOKEN`) raises it somewhat; a paid plan or a self-hosted model is needed for real traffic.
- **Decision (with the product owner):** ship it as a clearly labelled rough preview, with a friendly message when the daily limit is reached. Fakes stay the default.

## Tests

- `tests/unit/try-on-rules.test.ts`:
  - consent values, staleness rules and upload photo checks
  - garment canvas, the fake check and the fake try-on
  - `HuggingFaceTryOn` against a mocked Gradio client: dress parameters, token, fallback, quota → `TRYON_LIMIT`, abort, and no leaking of Space errors
- `tests/integration/try-on.test.ts`:
  - consent, upload validation, design and product try-ons
  - cache, the daily limit, photo rejection, timeout → retry, `TRYON_LIMIT`
  - a photo deleted while waiting, and ownership
  - immediate deletion, and the idempotent, audited 24-hour cleanup
- `tests/e2e/try-on.spec.ts` (`@supabase`, worker with fakes): consent gate → upload → try-on → design edit shows "Update try-on" without rerunning → update → keep → delete; product-page try-on; signed-out visitors.
