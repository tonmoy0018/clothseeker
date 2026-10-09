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
            5. ImageProvider.generateMotif → white knocked out → design-assets/{customer}/ai/
            6. renderPreview → design-assets/{customer}/ai/
            7. one transaction: ai_rounds row + job SUCCEEDED (only while holding the lease)
browser ──getJobStatus──▶ 4 option cards ──pickOption──▶ editor layers
```

## Providers

All provider code lives in `lib/ai/` behind two interfaces (`lib/ai/types.ts`):

| Interface | Methods | Fake (default) | Real |
|---|---|---|---|
| `PlannerProvider` | `detectBrandLogos(images)`, `planDesign(request)` | `FakePlanner`: deterministic, uses only allowed values | `GeminiPlanner` (`lib/ai/gemini.ts`), REST `generateContent` with a JSON response schema |
| `ImageProvider` | `generateMotif({ prompt, color, seed })` | `FakeImage`: deterministic SVG motifs | `CloudflareImage` (`lib/ai/cloudflare.ts`), Workers AI, FLUX.1 schnell by default |

`getAiProviders(env)` (`lib/ai/index.ts`) picks them from the worker's environment. Only the worker reads provider keys; the app's env schema contains no AI keys (a test checks this).

### Switching to the real providers

1. **Gemini:** create a key at [Google AI Studio](https://aistudio.google.com/apikey). In `.env.local` set `PLANNER_PROVIDER=gemini` and `GEMINI_API_KEY=…`. `GEMINI_MODEL` defaults to `gemini-2.5-flash`.
2. **Cloudflare Workers AI:** in the Cloudflare dashboard, copy the account id and create an API token with the *Workers AI* permission. Set `IMAGE_PROVIDER=cloudflare`, `CLOUDFLARE_ACCOUNT_ID=…` and `CLOUDFLARE_API_TOKEN=…`.
3. Restart `pnpm worker`. The `worker.started` log line names the active providers. If a chosen provider is missing its key, the worker refuses to start and names the missing variable.
4. **Before relying on them:** the adapters are tested only against mocked HTTP (`tests/unit/ai-providers.test.ts`). Run one round by hand, check the four previews, and try a photo with a well-known brand logo.

You can mix providers, e.g. the Gemini planner with fake images.

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
- **Timeouts.** Each attempt is limited to `AI_JOB_TIMEOUT_MS` (default 120 s). The `AbortSignal` is passed to providers, and the job is released even if a provider ignores it.
- **Retries.** `maxAttempts` is 3 (the first try plus 2 retries). Retryable failures (HTTP 408/429/5xx, network, timeout, unreadable or off-schema planner output, unexpected errors) go back to `QUEUED` with backoff of 10 s and then 40 s. Non-retryable failures (other 4xx, a brand logo, a template that is no longer available) fail immediately.
- **Stuck jobs.** Each poll requeues `RUNNING` jobs whose lease is older than timeout + 60 s, or fails them once their attempts are used up. Jobs survive the Mac mini restarting.
- **Failure codes** (`ai_jobs.error_code`) map to customer-safe messages in `lib/ai/errors.ts`. `ai_jobs.error` holds a short internal detail and is never shown.
- **Logs** contain ids, attempt numbers, durations, counts and codes only. They never contain instructions, prompts, photos or keys.
- **Files.** Motifs and previews go under `design-assets/{customerId}/ai/`. If a round doesn't complete, every file it stored is removed. Motifs of dropped variations are removed even when it succeeds.

## Prompt-injection and output safety

- The Gemini system instruction is fixed. The customer's words, design and photos are sent as data in the user turn, with an explicit rule that they are not instructions.
- The response schema restricts region ids, colours, patterns, fonts and style options to the template's own values.
- **Nothing the model returns is trusted.** `parsePlan` clips strings and rejects anything that isn't a plan. `variationToSpec`:
  - snaps colours to the nearest allowed colour
  - drops unknown regions, patterns, style options and fonts
  - refuses brand words in text and motif prompts
  - places AI layers in fixed boxes inside the template's areas
  - runs the same `validateDesignAgainstTemplate` as a manual design
  
  A variation that still doesn't pass is dropped.
- Cloudflare prompts wrap the planner's few words in fixed guidance ("no text, no logos") with punctuation stripped. Returned bytes are decoded with sharp and re-encoded through `processImage("aiMotif")`, like any upload.
- Picking an option revalidates its spec against the live template, in case the template changed after the round.

## Free-tier notes

- Gemini and Workers AI free tiers have per-minute and per-day limits. Jobs run one at a time per worker, and 429s are retried with backoff.
- One round costs one planner call (plus one logo check when photos are attached) and up to 4 image calls. At 10 rounds per customer per day, plan provider capacity accordingly.
- Clients poll every 2 s. Realtime updates can come later.

## Tests

- `tests/unit/ai-rules.test.ts`: hashing, brand words, Dhaka day, plan parsing and fitting, fakes, motif clean-up.
- `tests/unit/ai-providers.test.ts`: Gemini and Cloudflare adapters against mocked `fetch` (request shape, injection hygiene, error mapping).
- `tests/integration/ai.test.ts`: validation without quota use, quota (including concurrency), cache, claiming, retries, timeout, stuck recovery, brand-logo flagging, pick, follow-ups, and ownership.
