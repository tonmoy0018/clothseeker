# Architecture

Status: Phase 0. This document describes the target shape and marks what exists today.

## Overview

```
 Browser ──HTTPS──▶ Next.js app (Vercel Hobby)               Mac mini
                    ├─ app/(shop)   customer pages            ┌──────────────────────┐
                    ├─ app/seller   seller portal             │ worker/ (Node, tsx)  │
                    ├─ app/admin    admin tool                │  polls ai_jobs       │
                    ├─ app/api      route handlers            │  calls AI providers  │
                    ├─ server actions (mutations)             │  renders, uploads    │
                    └─ proxy.ts     session refresh only      └──────────┬───────────┘
                              │                                          │
                              ▼                                          ▼
                    ┌─────────────────────── Supabase ───────────────────────┐
                    │ Postgres (Prisma)   Auth   Storage (private buckets)   │
                    └────────────────────────────────────────────────────────┘
```

- **One Next.js app** serves all three surfaces. There is no separate backend service: reads happen in Server Components, mutations in server actions and route handlers.
- **The worker** runs outside the request path, so slow or rate-limited free-tier AI calls never block a user request. The app inserts rows into the Postgres `ai_jobs` table, the worker claims and processes them, and the browser polls job status. There is no Redis.
- **Supabase** provides Postgres (accessed through Prisma), Auth (session cookies through `@supabase/ssr`) and Storage (private buckets with short-lived signed URLs).

## Request path

1. `proxy.ts` refreshes the Supabase session cookie (`lib/supabase/proxy.ts`). It does **not** authorize anything.
2. Pages, server actions and route handlers authorize on the server: authentication, role, and store ownership (`lib/auth/`, Phase 1). Hiding something in the UI is never the access control.
3. Input is validated with Zod before any database or storage call.
4. Data access goes through Prisma (`lib/db`). Multi-record state changes run in transactions.

## Module map

| Path | Responsibility | Status |
|---|---|---|
| `lib/env/` | Zod-validated env. `schema.ts` is pure; `server.ts` is server-only; `client.ts` covers `NEXT_PUBLIC_*` only | Phase 0 |
| `lib/db/` | `client.ts`: Prisma factory (shared with the worker). `index.ts`: app singleton (server-only) | Phase 0 |
| `lib/supabase/` | Browser, server (cookie) and admin (secret key) clients, plus the proxy session refresh | Phase 0 |
| `lib/storage/` | Bucket constants, server-generated object keys, signed read URLs | Phase 0 |
| `lib/auth/` | Session lookup, roles, permission/ownership guards | Phase 1 |
| `lib/ai/` | `PlannerProvider`, `ImageProvider`, `TryOnProvider` interfaces and implementations | Phase 6–7 |
| `lib/renderer/` | DesignSpec → preview PNG, flat garment, 300 DPI print files | Phase 3 |
| `types/` | Shared Zod schemas and types (`DesignSpec`, …) | Phase 3 |
| `worker/` | Job loop, structured logging | Phase 0 (idle loop), Phase 6 (jobs) |
| `prisma/` | Schema, migrations, seed | Phase 0 (connection only), Phase 1 (models) |
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
