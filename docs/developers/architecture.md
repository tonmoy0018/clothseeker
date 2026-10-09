# Architecture

Status: Phase 5. This document describes the target shape and marks what exists today.

## Overview

```
 Browser ──HTTPS──▶ Next.js app (Vercel Hobby)               Mac mini
                    ├─ app/(shop)   customer pages            ┌──────────────────────┐
                    ├─ app/admin    team: catalog, orders,    │ worker/ (Node, tsx)  │
                    │               production, oversight    │  polls ai_jobs       │
                    ├─ app/api      route handlers            │  calls AI providers  │
                    ├─ server actions (mutations)             │  renders, uploads    │
                    └─ proxy.ts     session refresh only      └──────────┬───────────┘
                              │                                          │
                              ▼                                          ▼
                    ┌─────────────────────── Supabase ───────────────────────┐
                    │ Postgres (Prisma)   Auth   Storage (private buckets)   │
                    └────────────────────────────────────────────────────────┘
```

- **One Next.js app** serves both surfaces: the customer shop and the ClothSeeker team's admin tool. ClothSeeker is a single brand, not a marketplace, so there are no sellers or stores. There is no separate backend service: reads happen in Server Components, mutations in server actions and route handlers.
- **The worker** runs outside the request path, so slow or rate-limited free-tier AI calls never block a user request. The app inserts rows into the Postgres `ai_jobs` table, the worker claims and processes them, and the browser polls job status. There is no Redis. AI design rounds (Phase 6) are the first job type; see [ai-pipelines.md](ai-pipelines.md).
- **Supabase** provides Postgres (accessed through Prisma), Auth (session cookies through `@supabase/ssr`) and Storage (private buckets with short-lived signed URLs).

## Request path

1. `proxy.ts` refreshes the Supabase session cookie (`lib/supabase/proxy.ts`). It does **not** authorize anything.
2. Pages, server actions and route handlers authorize on the server: authentication, role (`customer` or `admin`), and, for customers, that the record belongs to them (`lib/auth/`, Phase 1). Hiding something in the UI is never the access control.
3. Input is validated with Zod before any database or storage call.
4. Data access goes through Prisma (`lib/db`). Multi-record state changes run in transactions.
5. Server actions are thin: authenticate → call a `lib/shop` service → map `ShopError` to a friendly message → redirect or revalidate. Business rules live only in the services.

Supabase's REST API is never used for data: every table has RLS enabled with no policies, so only server-side Prisma can access it (see [data-model.md](data-model.md#security-row-level-security)).

## Module map

| Path | Responsibility | Status |
|---|---|---|
| `lib/env/` | Zod-validated env. `schema.ts` is pure; `server.ts` is server-only; `client.ts` covers `NEXT_PUBLIC_*` only | Phase 0 |
| `lib/db/` | `client.ts`: Prisma factory (shared with the worker). `index.ts`: app singleton (server-only) | Phase 0 |
| `lib/supabase/` | Browser, server (cookie) and admin (secret key) clients, plus the proxy session refresh | Phase 0 |
| `lib/storage/` | Bucket constants, server-generated object keys, `StorageAdapter` (Supabase + in-memory) | Phase 0/2 |
| `lib/media/` | Untrusted image pipeline (sharp → validated WebP); see [media-uploads.md](media-uploads.md) | Phase 2 |
| `lib/admin/` | Admin services: products, variants, photos, templates, audit; all `assertAdmin` | Phase 2 |
| `lib/catalog/` | Size chart, pattern/font libraries, default template, customer template loader, signed catalog images | Phase 1/2 |
| `lib/auth/` | `session.ts` (current user, role from DB), `guards.ts` (`requireUser`, `requireAdmin`), `policy.ts` (pure rules), `safe-next.ts` | Phase 1 |
| `lib/shop/` | Domain services `(db, actor, input)`: `catalog.ts`, `cart.ts`, `checkout.ts`. No Next.js imports, so they're tested against a real DB | Phase 1 |
| `lib/payments/` | `PaymentProvider` (redirect + signed webhook) and the mock gateway; see [payments.md](payments.md) | Phase 4 |
| `lib/production/` | The team's flow: acceptance and refunds, production and QC, shipping, courier webhook, spec sheet and label PDFs; see [production.md](production.md) | Phase 5 |
| `lib/couriers/` | `CourierProvider` + mock courier (signed webhooks) | Phase 5 |
| `lib/orders/` | Checkout, webhook handling, expiry, **the order-item state machine**, queries; see [order-lifecycle.md](order-lifecycle.md) | Phase 4 |
| `lib/money.ts`, `lib/catalog/` | BDT minor units and formatting; brand size chart | Phase 1 |
| `lib/ai/` | `PlannerProvider`, `ImageProvider`, `TryOnProvider` interfaces and implementations | Phase 6–7 |
| `lib/renderer/` | Render plan → preview PNG, flat garment, 300 DPI print files (sharp + opentype.js outlines); see [rendering.md](rendering.md) | Phase 3 |
| `lib/design/` | DesignSpec validation, pricing, normalization (pure), and the customer design service (save, cart, uploads) | Phase 3 |
| `types/` | Shared Zod schemas: `template.ts` (v3), `design-spec.ts` (v1); see [design-spec.md](design-spec.md) | Phase 1+ |
| `worker/` | Job loop, structured logging | Phase 0 (idle loop), Phase 6 (jobs) |
| `prisma/` | Schema, migrations (incl. RLS lockdown), idempotent seed | Phase 1 |
| `supabase/` | Local stack config, buckets; RLS and storage policies later | Phase 0 |

## Key decisions

- **Prisma 7 with the `pg` driver adapter.** The generated client lives in `lib/generated/prisma` (gitignored, created on `pnpm install`). The connection URL is in `prisma.config.ts`, not in the schema.
- **Env files load the same way everywhere.** The app (Next.js), the worker, the scripts and the Prisma CLI all use `@next/env`'s `loadEnvConfig`.
- **Private storage only.** Object keys are `{ownerId}/{category}/{uuid}.{ext}` and are generated on the server. User filenames never become paths. SVG uploads are rejected for now because SVG can carry scripts.
- **Providers sit behind interfaces** (AI, payments, courier), so a free-tier provider can be swapped without touching domain logic.
- **The client polls job status.** Realtime subscriptions are a possible later improvement.

## Free-tier constraints

- Vercel Hobby is for non-commercial use, with function-duration and cron limits. Long work belongs in the worker.
- Gemini, Cloudflare Workers AI and Hugging Face Spaces have rate limits, cold starts and occasional downtime, so jobs need timeouts, retries and terminal failure states.
- The worker only runs while the Mac mini is on. Jobs must survive restarts (stuck-job recovery, Phase 6).
