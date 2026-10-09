# CLAUDE.md — ClothSeeker (single-brand custom clothing store)

This file is the persistent project contract. Read it before every task. If a request conflicts with it, stop and ask.

@AGENTS.md

## Project

An academic but realistic online custom-clothing store for **one company: ClothSeeker**. ClothSeeker designs, makes and ships every garment itself. There are no third-party sellers, it is **not a marketplace**, and there is no store/seller concept anywhere in the data model.

Two surfaces:

1. **Shop** (`app/(shop)`): customers browse, buy ready-made dresses, customize templates, use AI-assisted design, optionally try on, request quotes for special tailoring, check out, and track orders.
2. **Admin** (`/admin`): the ClothSeeker team manages the catalog (products, variants, templates), answers quote requests, accepts custom orders, runs production, uploads QC evidence, ships, and handles brand-logo flags, disputes, AI monitoring and the audit log.

This replaces the original marketplace brief (decided 2026-10-06): seller onboarding/approval, multi-seller order splitting, commission, payouts and reported listings are out of scope.

## Product rules

- Customers may buy a ready-made dress directly by choosing size and color.
- Customers may customize a ClothSeeker template.
- A design may start from a shop dress, a customer-uploaded dress photo, or a written description.
- Manual design supports per-part color/pattern, text, permitted images/logos, decorations, and style options: neckline, sleeve length, dress length.
- AI design accepts text plus up to 3 photos and returns 4 options per round.
- Customers can pick an option, generate again, or give a new instruction that references an option (e.g. "like option 2 but darker").
- Every AI round is retained. A selected AI result becomes editable DesignSpec layers.
- Virtual try-on is optional and runs only after explicit consent.
- Designs within a supported template can be ordered instantly.
- Designs started from a reference dress photo that need special tailoring can become quote requests.
- The ClothSeeker team answers quote requests with a price (or a decline) within 24 hours.
- The only content rule: **clothing brand logos cannot be used.**

## Stack (free-tier-first — do not change without approval)

| Concern | Choice |
|---|---|
| App | One Next.js App Router app, TypeScript, Tailwind CSS, shadcn/ui |
| Backend logic | Next.js API routes and server actions. No separate backend service |
| DB / auth / storage | Supabase (Postgres, Auth, Storage) |
| ORM / schema | Prisma |
| Job queue | Postgres `ai_jobs` table. No Redis |
| Worker | Node/TypeScript worker in `worker/`, run locally on the developer's Mac mini |
| Design canvas | Fabric.js |
| AI abstraction | Provider interfaces in `lib/ai/` |
| PlannerProvider | Gemini free tier: text/images, structured JSON, dress matching, brand-logo checking |
| ImageProvider | Cloudflare Workers AI or Hugging Face |
| TryOnProvider | Public Hugging Face Space/API |
| Background removal | `@imgly/background-removal` (in the browser) |
| Payments / shipping | Sandbox/mock payment gateway; mocked courier updates |
| Deployment | Vercel Hobby + Supabase |

Do not introduce a paid service without explicit approval.

## Non-negotiable engineering rules

- Strict TypeScript. Never use `any`. Never hide errors with unsafe casts, `@ts-ignore`/`@ts-expect-error`, or disabled lint rules.
- Validate every external or user input with Zod (request bodies, params, search params, form data, provider responses, env vars).
- Every mutation enforces **authentication, role, and resource ownership** on the server. Prefer server-side authorization to hiding things in the UI.
- Treat uploaded files as untrusted: check type (by content, not only the extension), size and dimensions; sanitize filenames and metadata; generate object keys on the server.
- Secrets live only in environment variables. Keep `.env.example` complete, with safe placeholders. Never put secrets in source, logs, client bundles, screenshots or commits. Only `NEXT_PUBLIC_*` variables reach the client.
- Use private buckets and signed URLs for private assets.
- Write business logic so it can be unit tested without a browser: pure domain modules, with I/O at the edges.
- Database migrations must be reproducible (`prisma migrate`, committed migrations).
- Use transactions for multi-record state changes.
- Never trust client-calculated price, role, user/owner ID, order status, or DesignSpec. Recompute and revalidate on the server.
- Add indexes for common catalog, order and queue queries.
- Keep every external integration (AI, payments, courier) behind an interface so providers can be swapped.
- Background jobs must be idempotent, safe under concurrency, and have timeouts, bounded retries and a terminal failure state.

## Core data concepts

### DesignSpec (JSONB, versioned)
- `version` (schema version, for migrations)
- base product / template reference (+ template version)
- size
- colors/patterns per part
- style options (neckline, sleeve length, dress length)
- layers per placement area
- `startedFrom`: `shop` | `photo` | `description`
- `referencePhotoUrl` (store a storage key; resolve to a signed URL when needed)

Defined once in `types/` as a Zod schema, with an inferred TypeScript type.

### AI
- `AIRound` = instruction + attachments + 4 option outputs + `chosenIndex`. Outputs are stored privately; keep storage keys, not public URLs.
- Maximum **10 rounds per customer per day**.
- Cache by a deterministic input hash.
- Never call AI providers from the browser. All provider work runs in the worker via `ai_jobs`.

## Ordering

- One customer order has one or more OrderItems (ready-made, custom design, or accepted quote). No splitting: ClothSeeker fulfils every item.
- Ready-made lifecycle: `paid → ready_to_ship → shipped → delivered`.
- Custom lifecycle states: `quote_requested, quoted, quote_declined, pending_payment, paid, awaiting_acceptance, accepted, in_production, qc_submitted, ready_to_ship, shipped, delivered, cancelled, refunded, disputed`.
- Paid custom items wait in `awaiting_acceptance` until the team accepts them, with a 24-hour deadline.
- Legal transitions live in **one** reusable domain module. Clients never set status directly.
- Payment callbacks are idempotent: retries must not create duplicate orders.

## Privacy

- Try-on requires explicit consent before any upload.
- Unsaved try-on photos/results are deleted after 24 hours by an idempotent, auditable cleanup.
- Try-on photos are never used for training.
- Store only the customer information needed for fulfillment. Show production views only what making and shipping the garment requires.
- Do not log personal data or image contents.

## Roles

`customer`, `admin`. Exactly two roles. Do not add sellers, staff sub-roles or team-member permission levels.

- `customer`: can only read and change their own cart, designs, AI rounds, try-on photos, quotes and orders. Every customer query is scoped to the signed-in user's id on the server.
- `admin`: the ClothSeeker team. Can do everything in `/admin`: catalog, templates, quotes, orders, production, QC, shipping, flags, disputes, AI metrics, audit log.
- Every protected route and mutation checks the role on the server. Sensitive admin actions write an `AuditLog` record (actor, action, target, timestamp, non-secret metadata).

## Folder contract

```
app/(shop)/        customer-facing routes
app/admin/         ClothSeeker team tool (catalog, quotes, orders, production)
app/api/           API routes
components/        UI components (shadcn/ui under components/ui)
lib/db/            Prisma client + data access
lib/auth/          session, roles, permission guards
lib/ai/            provider interfaces + implementations
lib/renderer/      server-side design rendering
worker/            local job worker
types/             shared types + Zod schemas (DesignSpec, etc.)
prisma/            schema, migrations, seed
supabase/          storage policies, RLS, config
docs/customers/
docs/admin/        guides for the ClothSeeker team
docs/developers/
```

## Phases

| # | Phase |
|---|---|
| 0 | Skeleton |
| 1 | Shop + auth + roles + Buy Now |
| 2 | Admin catalog + template editor |
| 3 | Manual design + renderer |
| 4 | Checkout + orders |
| 5 | Admin production flow (accept, spec sheet, QC, ship) |
| 6 | AI design box |
| 7 | Try-on + photo/description starts + quotes |
| 8 | Admin oversight (brand-logo flags, disputes, AI metrics, audit log) |
| 9 | Hardening + deployment |
| 10 | Documentation guides |

**Current status:** Phase 8 complete (2026-10-10). Next: Phase 9, which waits for explicit approval. Update this line when a phase passes its Finish Gate.

## Implementation conventions (established in Phase 0)

- Versions: Next.js 16 (`proxy.ts`, not `middleware.ts`; async `params`; global `PageProps`/`LayoutProps`), Prisma 7 (`prisma.config.ts`, `prisma-client` generator, `@prisma/adapter-pg`), Zod 4, Tailwind 4, shadcn/ui `base-nova` (Base UI primitives, `cn` from the `cn` package). Check `node_modules/next/dist/docs/` before relying on memory for Next.js APIs.
- Prisma is pinned to stable 7.x. Its npm `latest` tag points at an 8.0 RC; do not upgrade to it without approval.
- Env: add every new variable to `lib/env/schema.ts`, `.env.example`, `docs/developers/local-setup.md` and the CI placeholders. App code uses `getServerEnv()` / `getClientEnv()`. The worker and scripts use `parseEnv(...)` with `loadEnvConfig`.
- DB: app code uses `getPrisma()` from `@/lib/db` (server-only). The worker and scripts use `createPrismaClient()` from `@/lib/db/client`. The generated client is at `@/lib/generated/prisma/client`.
- Storage: never build object keys from user input. Use `buildObjectKey()`, and call `assertSafeObjectKey()` before signing or deleting. Buckets are private; keep `lib/storage/buckets.ts` in sync with `supabase/config.toml`.
- Local Supabase: `project_id = "clothseeker-p1"` on ports 55420–55429 (API 55421, DB 55422, Studio 55423), so it runs alongside another local project that uses `clothseeker` on the default ports. **Never stop, reset or migrate the `clothseeker` stack; it belongs to a different project.**
- Logging: structured JSON with ids, counts and error names only. No personal data, prompts, image data or connection strings.
- Lint forbids inline `eslint-disable` (`noInlineConfig`). Fix the code instead.

## Implementation conventions (established in Phase 1)

- Currency is **BDT**. Money is an `Int` in minor units (poisha) in `*Minor` fields; format with `formatBDT()` in `lib/money.ts`.
- **RLS:** every migration that creates a table must also run `ALTER TABLE … ENABLE ROW LEVEL SECURITY` (no policies). `pnpm db:check` and `tests/integration/rls.test.ts` enforce this.
- **Services:** business rules live in `lib/<area>/*.ts` as `fn(db, actor, rawInput)`. They parse input with Zod (`rawInput: unknown` when it comes from forms), check the role and ownership with `lib/auth/policy.ts`, and throw `ShopError` for expected failures. Server actions stay thin: guard, call the service, map the error, redirect.
- **Ownership:** when another user's record is targeted, scope the query by owner id and answer "not found", never "forbidden".
- **Auth:** the role always comes from the `users` table (`getCurrentUser`). Pages use `requireUser`/`requireAdmin` from `lib/auth/guards.ts`. Every admin page and action calls `requireAdmin()`; the layout alone is not a guard.
- **Tests:** unit tests in `tests/unit`. Integration tests in `tests/integration`, which use the `clothseeker_test` database (the name must end in `_test`) and the `resetDatabaseBeforeEach()`, `createUser()` and `createProduct()` helpers. E2E journeys that need sign-in are tagged `@supabase` and are excluded in CI.
- **Seed:** `prisma/seed.ts` is idempotent and refuses remote databases. The demo password is `SEED_DEMO_PASSWORD`.
- The `CustomizationTemplate.config` schema is `types/template.ts`.

## Implementation conventions (established in Phase 2)

- **Admin services** live in `lib/admin/*`. Each one calls `assertAdmin`, parses with Zod, and writes `writeAudit(tx, …)` **in the same transaction** as the change. Audit metadata holds field names, ids and statuses, never values or personal data. Expected failures throw `AdminError`, and server actions map them with `toFormState` (`app/admin/form-state.ts`).
- **Uploads:** always go through `processImage()` (`lib/media`), which only accepts real JPEG/PNG/WebP, re-encodes to WebP and strips metadata. The limit is 4 MB, because Vercel caps request bodies at 4.5 MB. Store images with `storeProductImage()` and keys from `buildObjectKey`. Never use client filenames.
- **Storage:** use the `StorageAdapter` interface (`getStorage()` in the app, `MemoryStorageAdapter` in tests). Buckets stay private; browsers only get signed URLs (`signCatalogImages`), and only for content the viewer may see.
- **Templates:** always read them with `parseTemplateConfig()`, which upgrades old versions. Saves use optimistic locking on `version`. Image keys must start with `{productId}/`. Customers load templates only through `getCustomizationTemplate()` (live product and live template). Patterns and fonts come only from the curated libraries in `lib/catalog/`.
- Shared client/server helpers such as `slugify` live in `lib/text/`. Client components must not import modules that pull in Prisma or `server-only`.

## Implementation conventions (established in Phase 3)

- **DesignSpec** (`types/design-spec.ts`, v1) is the single description of a custom dress. Server writes always go through `lib/design/service.ts`, which parses, revalidates against the **current live template** (`validateDesignAgainstTemplate`), re-stamps the template version, and recomputes the price (`priceDesign`). Client prices and validation are previews only.
- **Rendering:** the only input is `normalizeForRender(spec, template)`. Text is drawn from opentype.js outlines of `public/fonts/*.ttf`, never system fonts. Region recolor uses masks + multiply. Outputs must stay deterministic; `tests/unit/renderer.test.ts` hashes them. Don't render on page views, only on save/checkout/worker.
- **Fabric 7 quirks:** objects default to **centre origin**, so set `originX/originY: "left"/"top"` for anything positioned by its corner. The editor is client-only (`ssr: false`). The spec in React state is the source of truth, and the canvas is rebuilt from it.
- **sharp quirks:** `joinChannel` is a no-op on `create`d images, so build RGBA by hand (`rgbaFrom`). `.raw()` expands greyscale to 3 channels unless you extract a channel.
- Customer uploads live in `design-assets` under `{customerId}/uploads/`, and previews under `{customerId}/previews/`. Image layers may only reference the owner's uploads.
- `@imgly/background-removal` is AGPL. See `docs/developers/licences.md` before any commercial launch.

## Implementation conventions (established in Phase 4)

- **Order item status changes only through `transitionItems()`** (`lib/orders/transitions.ts`), which checks the kind, from/to and **actor type** (SYSTEM/ADMIN/COURIER/CUSTOMER) and writes an `OrderEvent`. Add new moves to the `TRANSITIONS` table and its tests.
- **Payments:** checkout uses `PaymentProvider` only. Orders become PAID **only** via a verified webhook (`handlePaymentWebhook`), which dedupes on `PaymentEvent.eventId` and checks the amount. Never mark an order paid from a page or action.
- `placeOrder` is idempotent per form-rendered key, renders print files **before** its transaction, deletes them if anything fails, and keeps the cart until payment succeeds. Unpaid orders expire after 30 min (`expireStalePendingOrders`, run by the worker).
- The worker uses `lib/storage/supabase-core.ts` (no `server-only`). App code uses `getStorage()`.
- Playwright spec files must not import each other; put shared steps in `tests/e2e/helpers.ts`.

## Implementation conventions (established in Phase 5)

- Team actions on order items go through `moveItemAsAdmin()` (`lib/production/move.ts`): admin check, state machine, audit in one transaction. Map `IllegalTransitionError` to a friendly `ProductionError`.
- **Refunds:** record `Refund` rows (`planItemRefunds`) in the status-change transaction, and pay out after commit (`settleRefunds`). Never call the provider inside a transaction. `uniqueKey` guarantees each refund happens at most once.
- **Couriers:** like payments, a provider interface plus a signed webhook; dedupe on `CourierEvent.eventId`, and statuses only move forward.
- **PDFs:** `pdf-lib` with the standard fonts; pass all text through `pdfSafe()`. The spec sheet must never include customer contact data (tested).
- **Migrations:** `prisma migrate dev` needs an interactive terminal when a change triggers a warning (e.g. a new unique index). Generate the SQL non-interactively with `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` into a new `prisma/migrations/<timestamp>_<name>/migration.sql`, append RLS for new tables, then `prisma migrate deploy`.
- **E2E tests that check out** sign up a fresh customer (`signUpFreshCustomer`), because checkout takes the whole cart.
- In zsh, unquoted variables don't word-split: use `${=VAR}` in shell commands.

## Implementation conventions (established in Phase 6)

- **AI providers** sit behind `PlannerProvider`/`ImageProvider` (`lib/ai/types.ts`). Deterministic fakes are the default everywhere. Gemini and Cloudflare are switched on by worker env vars only, and the app's env never holds AI keys.
- **Provider output is untrusted.** Always pass it through `parsePlan` + `variationToSpec` (template-valid or dropped), and pass images through `knockOutWhite` + `processImage("aiMotif")`.
- **Jobs:** the app queues (`createDesignRoundJob`), the worker claims with `FOR UPDATE SKIP LOCKED` (`claimNextJob`), and outcomes are written only under the lease (`leaseWhere`). Retryable errors are `AiProviderError(retryable: true)`; permanent ones are `AiJobRejected(code)`. Customer messages come from `error_code` via `failureMessage`.
- **Quota/cache:** 10 rounds per Dhaka day, enforced under a per-customer advisory lock. Invalid requests and cache hits never use quota.
- Image layers may use the customer's own `uploads/` or `ai/` keys (`isCustomerImageKey`). AI request photos live under `ai-inputs/`.
- Worker logs contain ids, counts, durations and codes only. Never log instructions, prompts or images.
- **AI drafts:** the first AI request on an unsaved design creates a hidden DRAFT design. The cache never hands a *saved* design to an editor that has no design open, because Save would overwrite it.
- **E2E:** Playwright starts the worker locally (health port 3101, fake providers). AI E2E tests sign up fresh customers for a full quota.

## Implementation conventions (established in Phase 7)

- **Try-on** (`lib/tryon/*`, worker `lib/ai/worker/try-on.ts`, [docs/developers/try-on.md](docs/developers/try-on.md)):
  - No upload without `consent: "yes"`. Photos and results live in `tryon-private` under `{customerId}/photos|results/`.
  - Unsaved media is deleted after 24 h by the audited, idempotent `cleanupTryOnMedia`. Deleting sets `deletedAt`; rows are never hard-deleted.
  - A design edit only marks a try-on stale (`isTryOnStale`). Never rerun automatically.
  - The limit is 5 per Dhaka day. `TryOnProvider` defaults to the fake; `huggingface` calls free public Spaces: rough preview, a tiny shared GPU allowance, and photos leave our systems.
- `PlannerProvider` also checks try-on photos (`checkTryOnPhoto`). Per-job-type timeouts go in `AiWorkerDeps.timeoutsMs`.
- **Start from a photo/description** (`lib/ai/starts.ts`, worker `dress-match.ts`): the planner may only pick an offered dress (`parseDressMatch`), and its colours, pattern and style are fitted via `matchToSpec` → `variationToSpec`. The result is a DRAFT design with `startedFrom` and `referencePhotoKey`; descriptions also queue a design round (`?job=` makes the AI box poll it).
- Motif images that are unusable or refused cost only that option's motif, never the round.
- **Quotes** (`lib/quotes/*`, `lib/admin/quotes.ts`, [docs/admin/quotes.md](docs/admin/quotes.md)):
  - Only for saved, photo-started designs. A quote freezes `specSnapshot` and its own preview.
  - Always use `effectiveQuoteStatus` (24 h to reply, 7 days to pay) rather than the raw status. `expireQuotes` is the idempotent sweep.
  - Quote cart lines are priced from the quote only; checkout re-checks them; the webhook sets the item to `ACCEPTED` and the quote to `ACCEPTED`.
- **Screenshots in docs** must not contain photos of real people we don't have rights to (e.g. research-dataset examples).
- This repo sits on an iCloud-synced Desktop: Finder can create "… 2.ts" copies (seen in `.next/`, `lib/generated/` and once in `tests/`). Delete them, and never commit them. The Next build now lives in `.next.nosync`, which iCloud skips.

## Implementation conventions (established in Phase 8)

- **Disputes:** customers report problems with delivered items for 14 days (`DISPUTE_WINDOW_DAYS`) via `openDispute`. The team resolves them through `resolveDispute` → `moveItemAsAdmin` (refunds use `planItemRefunds`/`settleRefunds`). Evidence views never include address or phone.
- **Audit:** `writeAudit` stores `actorRole`, so entries keep their meaning after an account is deleted. System sweeps write `actorId: null, actorRole: "SYSTEM"`. New admin pages, actions and routes must call `requireAdmin()` (or check `role !== "ADMIN"`); a test scans `app/admin/**` and fails otherwise.
- **AI health:** refusals by a daily limit call `recordLimitHit` after the refused transaction. Workers write `worker_heartbeats` each poll.
- **Build output** goes to `.next.nosync` locally (iCloud ignores `*.nosync`); Vercel keeps `.next`.
- **Emails** use the outbox (`lib/notifications`):
  - Queue with `notify(tx, …)` in the event's transaction; item-status emails come automatically from `transitionItems` (`itemNotificationKind`).
  - The worker sends them (`sendQueuedEmails`). The payload holds ids only; templates never include address, phone or images.
  - Locally emails go to Mailpit (http://127.0.0.1:55424).

## Mapping the original build guide

The phase prompts in *Enhanced_Claude_Code_Build_Prompts.pdf* were written for a marketplace. When following them, apply this file instead:
- "seller" / "seller portal" → the ClothSeeker team in `/admin`.
- Drop: Store, StoreMember and Payout models; seller application/approval; order splitting by store; commission; payouts; reported listings; cross-seller isolation tests.
- Seed data: 1 admin, 3 customers, 15 dresses (no seller stores).
- Keep every customer-ownership, validation, idempotency and privacy requirement.

## Working process

Before changing code:
1. Read this file and the relevant docs.
2. Inspect the existing implementation; do not assume a feature is missing.
3. State which files/modules will change and what the risks are.
4. Write a concise plan; when Plan Mode is requested, wait for approval.
5. Implement in small, reviewable increments.
6. Run typecheck, lint, the relevant unit/integration tests, and the build.
7. Fix any errors you introduced before calling the work done.
8. Preserve backward compatibility with completed phases.
9. Update docs whenever behavior, setup, data models, permissions or user workflows change.
10. Finish with a report: changed files, migrations, environment variables, tests run, known limitations, and the commit message.

Scope rules:
- Always ask before starting a new phase. Implement only the phase requested.
- Do not silently expand scope, change the stack, weaken permissions, or skip tests because something is hard.
- If a requirement is impossible on the free tier, explain the limitation and implement the closest replaceable abstraction. Do not silently change the product.
- If a phase is too large, propose splitting it into 2–4 independently testable sub-phases before coding.

## Finish Gate (after every phase)

Run everything and fix all errors. Write or update tests for the changed business logic. Run lint, typecheck and build. Verify the affected user flow manually where possible. Update the relevant docs. Inspect the git diff for accidental changes and secrets. Commit with a small, descriptive message. Do not start the next phase until this gate passes.

## Known constraints to keep visible

- Vercel Hobby is for non-commercial use, and it limits function duration and cron frequency. Slow AI work belongs in the worker, never in a request handler.
- Free AI tiers (Gemini, Cloudflare, Hugging Face Spaces) have rate limits, cold starts and occasional downtime. Design for queue delays and graceful failure.
- The worker runs only while the Mac mini is on. Jobs must survive restarts (stuck-job recovery).
- Clients poll job status. Realtime subscriptions are optional, for later.
- Gemini's **free tier may use submitted prompts/images to improve Google's products**. Fine for testing with our own photos; before real customers use AI photo uploads, switch to a paid tier or disclose it in the privacy policy.
- Free try-on Spaces give a rough preview and a tiny daily GPU allowance shared by the whole store (feasibility results in `docs/developers/try-on.md`). Real traffic needs a paid or self-hosted try-on model.

## Decided

- **Missed 24-hour acceptance deadline → full automatic refund** of the custom item (confirmed 2026-10-09). Same outcome when the team declines a custom item.
- **Quotes stay valid for 7 days** after the team sends a price (confirmed 2026-10-09). An unaccepted quote then expires automatically, and the customer can request a new one.

## Open decisions (resolve before the phase that needs them)

- None right now.
