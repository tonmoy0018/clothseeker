# AI pipelines

The AI design box suggests four variations of a customer's dress from a short description (and up to three photos). **The browser never talks to an AI provider.** The app validates the request and queues an `ai_jobs` row. The worker runs the job and stores the results privately, and the customer's page polls for the outcome.

```
browser ──server action──▶ createDesignRoundJob (lib/ai/jobs.ts)
                              │ validate · brand words · quota · cache
                              ▼
                           ai_jobs (QUEUED)
                              │ claimNextJob — FOR UPDATE SKIP LOCKED
                              ▼
worker ── runDesignRound (lib/ai/worker/design-round.ts)
            1. revalidate the design against the live template
            2. brand-logo check (instruction + photos) → FlaggedItem on a hit
            3. PlannerProvider.planDesign → untrusted JSON
            4. parsePlan + variationToSpec → template-valid DesignSpecs only
            5. drawn motifs only (no built-in decoration fits): ImageProvider.generateMotif
               → white knocked out → design-assets/{customer}/ai/
            6. renderPreview → design-assets/{customer}/ai/
            7. one transaction: ai_rounds row + job SUCCEEDED (only while holding the lease)
browser ──getJobStatus──▶ 4 option cards ──pickOption──▶ editor layers
```

## Providers

All provider code lives in `lib/ai/` behind two interfaces (`lib/ai/types.ts`):

| Interface | Methods | Fake (default) | Real |
|---|---|---|---|
| `PlannerProvider` | `detectBrandLogos(images)`, `planDesign(request)` | `FakePlanner`: deterministic, uses only allowed values | `GeminiPlanner` (`lib/ai/providers/gemini.ts`), REST `generateContent` with a JSON response schema; `LocalPlanner` (`planner-local.ts`), an open model on the worker's machine, on its own or standing in for Gemini |
| `ImageProvider` | `generateMotif({ prompt, color, seed })` | `FakeImage`: deterministic SVG motifs | `CloudflareImage` (`lib/ai/providers/cloudflare.ts`), Workers AI, FLUX.2 klein 4B by default, then FLUX.1 schnell |

`getAiProviders(env)` (`lib/ai/index.ts`) picks them from the worker's environment. Only the worker reads provider keys; the app's env schema contains no AI keys (a test checks this).

### Switching to the real providers

1. **Gemini:** create a key at [Google AI Studio](https://aistudio.google.com/apikey). In `.env.local` set `PLANNER_PROVIDER=gemini` and `GEMINI_API_KEY=…`.
2. **Cloudflare Workers AI:** in the Cloudflare dashboard, copy the account id (Account home → *Account details*). Create an API token from the **Workers AI** template (My Profile → API Tokens). Set `IMAGE_PROVIDER=cloudflare`, `CLOUDFLARE_ACCOUNT_ID=…` and `CLOUDFLARE_API_TOKEN=…`.
3. Restart `pnpm worker`. The `worker.started` log line names the active providers. If a chosen provider is missing its key, the worker refuses to start and names the missing variable.

You can mix providers, e.g. the Gemini planner with fake images. E2E tests always use the fakes, whatever `.env.local` says.

### What we learned running them live (2026-10-09)

- **Models get retired.** New Gemini keys can no longer use `gemini-2.5-flash` (HTTP 404). (The default has changed since; see "Models" below.)
- **Free-tier Gemini is often briefly overloaded** (HTTP 503 "high demand"), sometimes for minutes, on any single model. `GeminiPlanner` therefore tries `GEMINI_FALLBACK_MODELS` in order within the same attempt (on 429/5xx, network errors or 404) before the job-level retry kicks in. A bad request (other 4xx) never falls back.
- **FLUX.1 schnell on Workers AI accepts only `prompt` and `steps`.** Sending `seed` gives HTTP 400, so motifs from Cloudflare aren't reproducible from a seed. (FLUX.2 models take a multipart form instead: prompt, width and height.)
- **Cloudflare's safety filter sometimes rejects harmless prompts** (HTTP 400 "NSFW", e.g. "simple botanical flower icon"). A refused motif costs that option its motif, not the whole round (`ai.motif_skipped` in the logs). So does **Cloudflare's free daily allowance running out** (HTTP 429 with error code 4006, back at 00:00 UTC): rounds keep coming, with colours, patterns and text but no new motif pictures. Short rate limits and outages still retry the job.
- **The planner decides whether to add decorations.** For "delicate florals" it may choose a floral *pattern* instead.
- **Timing:** a round with 4 motifs took 30–65 s end to end. Each motif takes about 2 s on Cloudflare; the rest is Gemini, including fallbacks when a model is busy.
- **Images:** FLUX draws the motif small in the middle of a white square. `knockOutWhite` removes the white and crops the empty margin so the motif fills its box.

### Following the request (changed 2026-10-26)

Customers found the box "not reading the instructions": "add a logo on the left side of the chest" gave four designs with new colours, necklines and lengths, nothing on the chest, and summaries promising a star that wasn't there. Causes and fixes:

- **Change only what's asked.** The schema used to require every style choice, and the instruction asked for "4 distinct variations". Now `parts` and `styleOptions` hold only what a variation changes (the rest is kept from the current design), and the variations differ only in how they carry out the request. The fake planner follows the same rule.
- **Placement.** Items carry a `placement`: an area from `allowed.areas`, `across` (wearer-left / centre / wearer-right: the wearer's sides, so the wearer's left is the picture's right on the front and its left on the back), `down` (top / middle / bottom) and `size`. `placementBox()` turns it into a layer box; the option card shows the back when the variation's AI items are all on the back.
- **Built-in decorations first.** The planner picks one of `allowed.decorations` (star, heart, flower…) when one fits, which needs no image service; a drawn `motif` only otherwise. A motif whose words name a built-in decoration ("a small gold star") uses it too, and so does a motif whose picture couldn't be made. If nothing could be placed, the summary says so (`MISSING_MOTIF_NOTE`).
- **Honest summaries.** The summary is written last (`propertyOrdering`), so it describes what the variation contains instead of promising items the model then leaves out.
- **Follow-ups keep earlier AI items.** Earlier AI text and decorations stay unless a variation replaces them or lists them in `remove`; "like option 2 but darker" builds on option 2's own spec (revalidated, in the current size), not on the editor's design.
- **Real logos.** The planner never draws a real logo, crest or trademark (brands, clubs, teams, companies). It uses a simple decoration in the customer's colours and says in the summary that they can upload their own image under Personalise, where the clothing-brand rule still applies.
- **Speed and model.** Gemini 3 models think deeply by default: `gemini-3.8-flash` took 77–150 s per plan (or ran past the 180 s job limit), which failed whole rounds. Requests now use `thinkingLevel: "low"`, and the default became `gemini-3.1-flash-lite` (3–10 s, same placement and choices in tests); it has changed again since, see "Models" below. Small models occasionally ramble until the output limit: `maxOutputTokens` (4096) stops that quickly, and an unreadable or cut-off answer moves on to the next model.

### Models (changed 2026-11-11)

- **Planner:** `GEMINI_MODEL` defaults to **`gemini-3.6-flash`**, the strongest Flash model that answered reliably on the free tier when measured. `GEMINI_FALLBACK_MODELS` then tries `gemini-3.5-flash`, `gemini-3.5-flash-lite` and `gemini-3.1-flash-lite`, in that order, when a model is busy, retired or answers badly.
- **Motifs:** `CLOUDFLARE_IMAGE_MODEL` defaults to **FLUX.2 klein 4B** (`@cf/black-forest-labs/flux-2-klein-4b`). It keeps to the colour it's asked for, which FLUX.1 schnell often doesn't, and its safety filter doesn't refuse harmless words such as "paisley teardrop". It costs about 104 neurons a picture (schnell: about 58), so the free 10,000 neurons a day give roughly 95 motifs, shared with the product shots below.
- **Motif fallback:** `CLOUDFLARE_FALLBACK_IMAGE_MODELS` (default FLUX.1 schnell) is tried when the model fails, except for a wrong key or the daily allowance running out. Every Cloudflare model draws on the same allowance, so another model wouldn't help; the option goes on without a motif, as before.
- **Product shots:** `GARMENT_SHOT_PROVIDER=cloudflare` uses the same FLUX.2 model (`CLOUDFLARE_SHOT_MODEL`), which also edits pictures. See "AI product shot" under the customer's own dress.

### The planner on our own machine

`PLANNER_PROVIDER=local` (or `PLANNER_FALLBACK=local` beside Gemini) runs an open model on the worker's Mac, so no request or photo leaves it and there is no daily allowance.

- **Model:** Qwen3.5-4B (Apache-2.0), 4-bit GGUF with its picture encoder: 3.4 GB in `~/.cache/clothseeker/local-llm`, pinned by commit and SHA-256 (`lib/ai/providers/local-llm-setup.ts`). It reads text and photos. It's the strongest open vision-language model we found that fits beside the Supabase stack on 8 GB.
- **Setup:** `brew install llama.cpp`, then `pnpm llm:setup`. The worker refuses to start with the local planner until both are there.
- **How it runs:** the worker starts llama.cpp's `llama-server` on the first request (`LlamaServerProcess`), on a free port of 127.0.0.1 only, offline, with nothing but `PATH` and `HOME`, and stops it after 5 idle minutes or when a request runs out of time. `LocalPlanner` sends the same instructions and the same answer shapes as the Gemini planner (`gemini.ts` exports them). The shapes become a grammar (`toJsonSchema`), so the answer is always valid JSON of the right form; `parsePlan` and the other validators still check it.
- **One big model at a time:** the planner model and the try-on model each need about 3 GB. `ModelSlot` stops whichever is loaded when the other is needed; the worker runs one AI job at a time, so nothing is stopped mid-job. After a switch, the next job waits for its model to load (10–20 s).
- **Measured on the 8 GB M1 MacBook Air (2026-11-13):** about 13 tokens a second. A design plan (four options, about 1,100 tokens) took **about 105 s**; a plan with a photo 61 s; reading a garment photo 35 s; a logo check 12 s. All four answers passed our validation, and the plans did what was asked ("skirt navy, small gold star on the left chest" gave a navy skirt and a gold star at wearer-left on the chest in all four, small in three of them). Gemini takes 3–10 s for the same plan.
- **So Gemini stays the first choice, and the local model stands in** (`PLANNER_FALLBACK=local`, `FallbackPlanner`): when Gemini can't answer (busy, out of its free allowance, unreachable, a wrong key, an unreadable answer), the local model answers the same request and the worker logs `ai.planner_fallback`. A request Gemini blocked on purpose isn't passed on, and neither is one that ran out of time. Design jobs get `LOCAL_LLM_TIMEOUT_MS` (5 minutes) instead of `AI_JOB_TIMEOUT_MS` when the local model may answer.
- **Limits:** it's a much smaller model than Gemini's. It follows simple requests well; expect weaker results on involved ones. **Brand logos:** tested on 2026-11-15 on the Oxford shirt's catalogue photo with marks added on the chest: NIKE, a drawn swoosh (no text), adidas, GUCCI and ZARA were all caught and named, and the plain shirt, an "Ava" monogram and a small flower weren't flagged (8 of 8, 7–14 s each). Printed marks only; a small, blurred or partly hidden logo is harder, so Gemini stays the first check.
- **Check it:** `pnpm tsx scripts/ai/check-local-planner.ts ["a request"]` runs sample requests and prints times, token counts and whether each answer passed validation.

### Privacy note for the real providers

The local planner (above) keeps everything on the worker's machine.

On the **free tier, Google may use prompts and images to improve its products.** That includes customer photos attached to AI requests. That's acceptable for testing with your own pictures. Before real customers use it, move to a paid tier (which doesn't use data for training) or state it clearly in the privacy policy.

Cloudflare Workers AI receives the planner's short motif description. With `GARMENT_SHOT_PROVIDER=cloudflare` it also receives **the customer's photo of their garment** (re-encoded first, so only its pixels leave), which may show a person wearing it. That's off by default. With `SKETCH_PROVIDER=cloudflare` (or `gemini`) it receives **customers' drawings** and the note they add; also off by default (the fake renders them locally). Before real customers use it, check what Cloudflare keeps and say so in the privacy policy. Try-on photos never go to Cloudflare or Gemini.

### The fakes

- They are deterministic: the same request and seed give the same plan and the same motif. Colours named in the instruction come first. "dark"/"evening" and "light"/"pastel" reorder the palette, and quoted text ("Ava") becomes a text layer.
- `AI_FAKE_DELAY_MS` (default 1500) adds latency so the loading states are visible. Tests use 0.
- **Testing convention:** `FakePlanner.detectBrandLogos` reports a logo when a photo's dominant colour is the marker red `#E4002B`. This is not real detection. Real detection only happens with Gemini.

## Request rules (`createDesignRoundJob`)

Checked in this order, and nothing before the quota step uses quota:

1. **Customer only.** The instruction is 3–500 characters. Up to 3 attachments, each one the customer's own file under `{customerId}/ai-inputs/` that actually exists. The design must be valid against the live template, and the template must have `aiEnabled`. A `reference` (follow-up) must be one of the customer's own rounds.
2. **Brand words.** `findBrandTerm` (`lib/ai/brands.ts`) looks for distinctive clothing-brand names as whole words. A hit is rejected with the exact message *"Clothing brand logos can't be used. Try your own logo or another image."* The list is deliberately precise, so ordinary words such as "puma", "supreme" or "yellow" are not blocked.
3. **Cache.** `inputHash` is the SHA-256 of canonical JSON of: customer, validated spec, normalized instruction (case and whitespace folded), sorted attachment keys, reference, and `generation`. An existing round with that hash is returned (as its original `jobId`) with no provider call and no quota. An identical request that is still queued or running gets that job back, which also handles double-clicks.
4. **Generate again** sets `generation` to the design's round count + 1, so the hash changes and the results are fresh.
5. **Quota.** Rounds created today plus this customer's queued or running jobs must be below **10**. Days follow Asia/Dhaka. A failed job doesn't count. There is also a limit of 30 submissions a day, so failures can't hammer providers. A per-customer advisory lock (`pg_advisory_xact_lock`) serialises the check, so concurrent requests can't slip past it (tested).
6. If the design isn't saved yet, it is stored as a **DRAFT**. Drafts are hidden from My designs and become SAVED when the customer presses Save.

## Worker behaviour (`lib/ai/worker/`)

- **Claiming** is one `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING`. It sets `RUNNING`, increments `attempts`, and stamps `locked_at`/`locked_by`. Any number of workers can run at once (tested with 12 concurrent claims).
- **Leases.** A job is finished only with `updateMany` guarded by `id + RUNNING + locked_by + attempts`. A worker that lost its lease (timed out, or recovered elsewhere) can't overwrite the outcome, and its round transaction rolls back.
- **Timeouts.** Each attempt is limited to `AI_JOB_TIMEOUT_MS` (default 180 s). The `AbortSignal` is passed to providers, and the job is released even if a provider ignores it.
- **Retries.** `maxAttempts` is 3 (the first try plus 2 retries). Retryable failures (HTTP 408/429/5xx, network, timeout, unreadable or off-schema planner output, unexpected errors) go back to `QUEUED` with backoff of 10 s and then 40 s. Non-retryable failures (other 4xx, a brand logo, a template that is no longer available) fail immediately.
- **Stuck jobs.** Each poll requeues `RUNNING` jobs whose lease is older than timeout + 60 s, or fails them once their attempts are used up. Jobs survive the Mac mini restarting.
- **Failure codes** (`ai_jobs.error_code`) map to customer-safe messages in `lib/ai/errors.ts`. `ai_jobs.error` holds a short internal detail and is never shown.
- **Logs** contain ids, attempt numbers, durations, counts and codes only. They never contain instructions, prompts, photos or keys.
- **Unusable motifs.** A motif image that can't be read, or is nearly empty after removing the background, costs that option its motif and is logged as `ai.motif_skipped`; the round still succeeds. Thin motifs are padded to at least 160 px after cropping.
- **Files.** Motifs and previews go under `design-assets/{customerId}/ai/`. If a round doesn't complete, every file it stored is removed. Motifs of dropped variations are removed even when it succeeds.

## Prompt-injection and output safety

- The Gemini system instruction is fixed. The customer's words, design and photos are sent as data in the user turn, with an explicit rule that they are not instructions.
- The response schema restricts region ids, colours, patterns, fonts and style options to the template's own values.
- **Nothing the model returns is trusted.** `parsePlan` clips strings and rejects anything that isn't a plan. `variationToSpec`:
  - snaps colours to the nearest allowed colour
  - drops unknown regions, patterns, style options and fonts
  - refuses brand words in text and motif prompts
  - places AI layers inside the template's areas (`placementBox`; unknown areas fall back to the default area)
  - uses only the template's allowed decorations
  - runs the same `validateDesignAgainstTemplate` as a manual design
  
  A variation that still doesn't pass is dropped.
- Cloudflare prompts wrap the planner's few words in fixed guidance ("no text, no logos") with punctuation stripped. Returned bytes are decoded with sharp and re-encoded through `processImage("aiMotif")`, like any upload.
- Picking an option revalidates its spec against the live template, in case the template changed after the round.

## Free-tier notes

- Gemini and Workers AI free tiers have per-minute and per-day limits. Jobs run one at a time per worker, and 429s are retried with backoff.
- One round costs one planner call (plus one logo check when photos are attached) and up to 4 image calls. At 10 rounds per customer per day, plan provider capacity accordingly.
- Clients poll every 2 s. Realtime updates can come later.

## Start from a dress photo or a description (Phase 7)

`/design/start` (`app/(shop)/design/start/*`), app side `lib/ai/starts.ts`, worker `lib/ai/worker/dress-match.ts`.

```
photo:        upload (processImage, design-assets/{customer}/references/) ─┐
description:  brand words · one AI round left today ────────────────────────┤→ ai_jobs (DRESS_MATCH)
worker: candidates = live dresses with a live template (descriptions: AI-enabled only)
        photo → brand-logo check (FlaggedItem on a hit)
        planner.matchDress → parseDressMatch (must be an offered dress, ≤ 2 alternatives)
        → startingSpec + matchToSpec (colors, pattern, style fitted to the template)
        → DRAFT design (startedFrom PHOTO/DESCRIPTION, referencePhotoKey)
        → description: createDesignRoundJob on it (normal quota rules)
browser: polls → /customize/{product}?design=…[&job=round][&alts=a,b]
```

- **Untrusted answer.** The planner must choose one of the offered `productId`s, or the attempt is retried and finally fails with `INVALID_PLAN`. Colours snap to the template's allowed colours, a pattern applies to the skirt (or first recolorable region) only if allowed, and style words match option ids or labels.
- **Reference photo.** Saved on the design (`referencePhotoKey`) and shown beside the canvas. `validateDesignAgainstTemplate` only accepts the customer's own `{customerId}/references/` keys.
- **Limits and cache.** A dress match counts toward the 30-requests-a-day limit only. A description start also needs one of the day's 10 AI rounds, used by the round it queues. An identical request (same photo or same normalized description) gets the earlier job back while its design still exists.
- **Upload, then choose** (2026-11-02). The photo is uploaded first (`uploadDressPhotoAction`). The customer then picks one of three options:
  - **Make this exact dress**;
  - **Customize this dress**;
  - **Start from our closest dress**, the match above.

  They also say what it is: dress, shirt or panjabi.

### Your own dress (mode `own`, `lib/own-dress/build.ts`)

Its own entry is **Upload your dress** (`/design/upload`), linked from the site menu and the home page. The page shows the photo part of the start form only (`StartForms photoOnly`), with the same three choices. `/design/start` keeps both the photo and the description starts.

```
own:    the same DRESS_MATCH job, payload.own = { garmentType ("auto" by default), exact }
worker: brand-logo check (as above)
        → garmentShot.productShot (optional: an AI product shot of the same garment; null = use the photo)
        → planner.readGarment → parseGarmentReading (lib/own-dress/read.ts; failures = no reading)
        → ownPhotoPicture (lib/garment-photo/template.ts → frameGarmentPhoto: the whole garment cut out
          onto the studio backdrop, cut into Sleeves/Bodice/Skirt or Body)
        → PRIVATE product (owner = the customer; every size, price 0, never sold directly)
          + template (AI on; front picture, part masks, print areas, recolor "shade",
            one style option per group: "As in your photo")
        → design: SAVED with a preview (exact) or DRAFT (customize)
browser: /customize/{product}?design=… (see it → "Try it on" → "Request a price")
```

- **The picture.** It looks like a catalogue shot and is the same garment.
  - **Not lined up.** It isn't lined up like the catalogue's style pictures: that framing crops to the shoulders-to-waist and enlarges, which cut most of a long garment away and blurred the rest. Instead the whole garment is fitted into the 900×1170 picture, uncropped and centred. The mannequin, stand and backdrop are removed, and the garment is placed on a plain studio backdrop (`BACKDROP`).
  - **Several colours.** Customer photos are cut out with `findGarment(…, { colours: "several" })`. It follows the garment wherever it stands in the photo, keeps every main colour (a k-means of the garment's middle), and fills pale fabric inside the garment's rows that barely differs from the backdrop (a white shirt inside an open black jacket).
  - **Print sizes.** They come from the garment's shoulder width (37 cm for dresses, 46 cm for tops), kept within 45–100% of the garment's width.
- **What the AI reads** (decided 2026-11-05). The worker asks the planner one more question about the photo (`readGarment`, Gemini about 2–5 s). It gets back:
  - the type (dress, shirt, panjabi or other; jackets, coats and tops count as shirts);
  - a name;
  - the main garment's box, as 0–1000 of the photo;
  - neckline or collar, sleeves and length;
  - up to 3 colours, a print and up to 5 details;
  - a description.

  `parseGarmentReading` treats the answer as untrusted. Words are trimmed and limited to plain characters, and brand names are dropped. Boxes too small to be the garment are ignored, and an unreadable answer is no reading. The reading is used for:
  - **Type.** "What is it?" defaults to "Let us work it out" (`auto`). The AI's type is used, else a dress; a type the customer picks wins.
  - **Where the garment is.** The cut-out still learns the backdrop from the whole photo's edges, but keeps only the garment inside the box, plus a 2% margin (`analysePhoto(…, within)`). That leaves out the trousers under a jacket or a bag beside a dress. If nothing is found there, it tries the whole photo. Cropping to the box was tried first, but the tight edges then counted as backdrop and left a pale rectangle behind the garment.
  - **Name.** "Your black hooded open jacket", else "Your dress".
  - **Style labels.** The one "as in your photo" option per group is labelled with what was read ("Hooded", "Long sleeves").
  - **For the team.** The description, colours, print and details become the product's description. The team's quote page shows it as "What the photo shows", marked as read by AI.

  If the AI can't answer, the garment is built as without it (tested).
- **Its own parts** (decided 2026-11-05). The reading includes 2–7 parts of this garment: a label, a box and the part's colour, for example jacket body and inner shirt, or bodice, waistband and skirt. Free Gemini models can't draw reliable outlines (tried: invented images, boxes only, placeholders), so each part's outline is worked out here (`assignParts`, `lib/garment-photo/parts.ts`):
  - **Colour first.** Within the boxes, each garment pixel goes to the part whose colour it matches, so a white shirt inside an open black jacket is told apart.
  - **Then shape and size.** Where colours match, the shape-based split decides for named sleeves, straps, bodices and skirts, and the smaller box wins (a waistband over a skirt).
  - **Folded in.** A small same-colour part inside a bigger one would be a rectangle, so it's folded in (`separableHints`), unless it's a band across it.
  - **Left out.** Garment pixels outside every box (a mannequin's neck, trousers under a jacket) are dropped.

  Each part becomes a region the customer can recolour on its own, with its own print area. With fewer than two usable parts, the shape-based parts are used, as before.
- **AI product shot** (approved 2026-11-05). The photo is first sent to an image model for a clean product shot of the same garment, and the reading, parts and cut-out use that. Anything but a picture means the photo is used as it is. The team is told when the picture is an AI shot, and the customer's photo stays the reference. Two providers (`GARMENT_SHOT_PROVIDER`, default `none`):
  - `cloudflare` (added 2026-11-11): FLUX.2 klein 4B on Workers AI (`CLOUDFLARE_SHOT_MODEL`), about 125 neurons a shot from the free daily allowance it shares with the motifs. The photo is sent to Cloudflare. When the allowance is used up, or the model refuses or answers oddly, there's no shot.
  - `gemini`: `GEMINI_IMAGE_MODEL` (default `gemini-2.5-flash-image`). On a free key Google answers 429, since there's no image allowance; it's billed per image once billing is on.
- **Paired parts** (2026-11-11). The AI boxes "Left sleeve" and "Right sleeve" separately (tight boxes tell the sides from the body between them); the two sides become one part, "Sleeves", that the customer recolours together (`pairName`, `lib/garment-photo/parts.ts`).
- **From a drawing** (added 2026-11-15). The customer ticks "This is a drawing or sketch" on the Upload page and may add a note on what it should be made of ("Red silk with a gold hem", at most 200 characters, brand names refused like descriptions).
  - **Two steps.** First a `sketch` job (`renders.note`, `renders.round` in the payload) checks the drawing for brand logos and has a `SketchRenderer` make `SKETCH_RENDERS` (3) realistic product photos of the garment (`lib/ai/sketch.ts`: the garment exactly as drawn, the note only for fabric and colours, front view on an invisible mannequin, studio grey backdrop). They're stored under the customer's own `sketch-renders/`, and the status check signs them for the page (`state: "rendered"`). Renderings that fail are skipped.
  - The customer picks the closest ("Use this one"), or asks for three more ("None of these: show me three more", the next `round`; the same drawing, note and round give the cached set). The picked one goes to the usual own-dress job as `own.renderKey` (checked to be under that customer's `sketch-renders/`), which builds from it without rendering again: reading, parts, cut-out, private product, quote.
  - A request with `own.sketch` and no `renderKey` still renders one picture itself (the first version of this feature).
  - Renderings that weren't picked stay in storage (a few hundred kB each); they aren't cleaned up yet.
  - `SKETCH_PROVIDER`: `fake` (default: fills the drawn outline with the note's colour, for development and tests), `cloudflare` (FLUX.2 klein, `CLOUDFLARE_SKETCH_MODEL`, within the free daily allowance) or `gemini` (`GEMINI_IMAGE_MODEL`, paid keys only).
  - The rendering is needed, unlike a product shot: a busy service is retried; a refusal, no allowance left or an unusable picture ends the job with `SKETCH_NOT_RENDERED` ("We couldn't turn your drawing into a garment this time…"), leaving nothing behind.
  - The drawing stays the design's reference picture, so the team sees it beside the rendering on the quote; the product's description says its picture is an AI rendering of the customer's sketch ("make what it shows").
  - The design records it (`Design.referenceIsDrawing`, copied to its quote; since 2026-11-16), so the design screen, the quote request and both quote pages say "your drawing" ("Made to order from your drawing", "Customer's drawing") instead of "your photo". "Start from our closest dress" with a drawing sets it too (payload `drawing: true`). Designs made from drawings before then were marked by the migration from their product's description.
  - "Start from our closest dress" with a drawing matches it like a photo (the planner reads drawings), without rendering it.
  - A 3D preview of any garment or design is the 3D view ([3d-view.md](3d-view.md)): TripoSR on the worker's machine.
- **The order on the design screen.** First the garment, then a "See it on you" step ("Try it on" opens the try-on panel), then "Get a price for your dress". The quote isn't pushed first. Both sit in the page, not in the bar pinned to the bottom, which keeps only the size and Save (a tall pinned bar covered the AI options).

- **Private.** `status: PRIVATE` keeps it out of everything that shows ACTIVE products:
  - the shop, product pages and filters;
  - try-on of ready-made items;
  - decoration cut-outs;
  - the dress matcher's candidates;
  - the photo scripts.

  The loaders (`getCustomizationTemplate`, `loadDesignContext`) let only its owner load it (`viewerId`). Admin catalogue queries exclude it (`IN_CATALOG`, `lib/catalog/product-status.ts`); the team sees it through its quote. If the account is deleted, `ownerId` becomes null and the dress stays private.
- **Customising.** Customers can recolour each part, keeping the photo's folds, and add patterns, text, decorations, uploads and finishes. They can't change the cut. The AI design box works on them as on our dresses (decided 2026-11-05; rounds count towards the daily limit), with every option keeping the cut "As in your photo".
- **Ordering.** Only through a quote:
  - `addDesignToCart` and checkout refuse these designs (`QUOTE_ONLY`);
  - "My designs" shows "Priced by quote";
  - the editor shows "Request a price" instead of a total and "Add to cart";
  - notes are optional for these quotes, and still required when tailoring one of our dresses.
- **No dress found.** If no garment is found in the photo, the job fails with `GARMENT_NOT_FOUND` and nothing is left behind. A job that loses its lease after building removes what it built (`removeOwnDress`).
- **Live results (2026-10-09, Gemini + Cloudflare):**
  - A photo of a striped dress gave the tiered midi with a terracotta skirt, ivory stripes, a square neckline and midi length (28 s).
  - "A romantic floral maxi in lilac for a spring wedding, with long sleeves" picked a matching dress (21 s), then four lilac floral designs with motifs (22 s).

## The AI box (UI)

`app/(shop)/customize/[productId]/ai-box.tsx`, with server actions in `ai-actions.ts`:

- **Instruction and examples.** There is a 500-character box and example chips ("Pastel florals on the skirt", "Make it evening-ready in emerald", "Like option 2 but darker"), plus the note "Clothing brand logos can't be used." and "N of 10 AI rounds left today".
- **Photos.** Up to 3 photos of any size. Each one is downscaled **in the browser** to at most 2000 px (as JPEG, compressed further if needed) before upload, so requests stay under Vercel's 4.5 MB body limit. The server then re-encodes it (`processImage("aiInput")`), enlarging small ones to 256 px on the shorter side.
- **Generate** queues a job. The box shows four loading cards and polls `getJobStatusAction` every 2 s, stopping when the job finishes or fails, after 10 minutes, or when the page is left. A cache hit says it didn't use a round.
- **Results.** Each option card has **Pick** and **Refine**. Refine sets "Refers to option N" for the next instruction. Typing "option 2" while results are on screen refers to that option automatically. **Generate again** repeats the last request with fresh results.
- **Pick** revalidates the option on the server, then replaces the working design as one undoable step. Its colours, pattern, style, text and motif become ordinary editable layers, and the price updates.
- **Previous rounds** for the design are listed (picked option marked). Clicking one shows its options again.
- **Drafts.** The first AI request on an unsaved design creates a hidden draft and puts `?design=<id>` in the URL, so a reload keeps the rounds. The Save button keeps saying "Save design" until the customer saves.

## Tests

- `tests/unit/ai-rules.test.ts`: hashing, brand words, Dhaka day, plan parsing and fitting, fakes, motif clean-up.
- `tests/unit/ai-providers.test.ts`: Gemini and Cloudflare adapters against mocked `fetch` (request shape, injection hygiene, error mapping).
- `tests/e2e/ai.spec.ts` (`@supabase`, worker started by Playwright): generate → 4 loading cards → 4 options → pick (price and colours update, undo/redo) → refine → generate again → save and reload with history; the brand message and no quota use.
- `tests/integration/starts.test.ts`: photo start (colour, reference photo, valid spec), brand logo → flag, ownership of reference photos, a rogue planner answer → retries → `INVALID_PLAN`, description start → matched dress + queued round, brand words, the daily limit and cache.
- `tests/e2e/starts.spec.ts` (`@supabase`): photo start opens the design screen with the photo and colour; description start opens the matched dress with four AI ideas; brand words are refused.
- `tests/integration/ai.test.ts`: validation without quota use, quota (including concurrency), cache, claiming, retries, timeout, stuck recovery, brand-logo flagging, pick, follow-ups, and ownership.
