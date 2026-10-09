# Local setup

This guide takes a fresh clone to a running app, database and worker on macOS (the developer Mac mini). Linux works the same way.

## 1. Install prerequisites

| Tool | Version | Check |
|---|---|---|
| Node.js | 22.12+ or 24 LTS | `node -v` |
| pnpm | 12 (pinned in `package.json`) | `pnpm -v` (or `corepack enable`) |
| Docker Desktop | running | `docker info` |

Node 26 works, but Prisma 7 prints an "unsupported Node.js version" warning on install. CI uses Node 24.

## 2. Install dependencies

```bash
pnpm install
```

`postinstall` runs `prisma generate`, which writes the client to `lib/generated/prisma/` (gitignored). `pnpm-workspace.yaml` allows build scripts only for `esbuild`, `prisma`, `@prisma/engines` and `supabase`.

## 3. Start local Supabase

```bash
pnpm db:start
```

The first run downloads the Supabase Docker images. The stack is configured in `supabase/config.toml`:

- `project_id = "clothseeker-p1"`: Docker containers and volumes are named `supabase_*_clothseeker-p1`.
- Ports 55420–55429, so it doesn't clash with other local Supabase projects on the default 543xx ports.
- Four **private** storage buckets, created on start: `product-media`, `design-assets`, `qc-photos`, `tryon-private`.
- Edge Functions, analytics and vector storage are disabled (not used).

`pnpm db:stop` stops the stack and keeps its data. `pnpm exec supabase stop --no-backup` also **deletes** the local data.

## 4. Create `.env.local`

```bash
pnpm env:local
```

This reads `supabase status` and writes `.env.local` (mode 600, gitignored). For a hosted Supabase project, copy `.env.example` and fill it in by hand.

### Environment variables

| Variable | Where it comes from | Exposure | Used by |
|---|---|---|---|
| `NEXT_PUBLIC_APP_URL` | Your app URL (`http://localhost:3000` locally) | Client-safe | App |
| `NEXT_PUBLIC_SUPABASE_URL` | Local: `API_URL` from `pnpm db:status`. Hosted: Project Settings → API | Client-safe | App, proxy, worker |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Local: `PUBLISHABLE_KEY`. Hosted: API Keys → publishable | Client-safe (RLS protects data) | App, proxy |
| `SUPABASE_SECRET_KEY` | Local: `SECRET_KEY`. Hosted: API Keys → secret | **Server-only**, bypasses RLS | Server code, worker |
| `DATABASE_URL` | Local: `DB_URL`. Hosted: pooled connection string (port 6543) | **Server-only** | Prisma at runtime |
| `DIRECT_URL` | Local: same as `DATABASE_URL`. Hosted: direct/session string (port 5432) | **Server-only** | `prisma migrate` |
| `WORKER_POLL_INTERVAL_MS` | Optional, default 5000 | Worker-only | Worker |
| `TEST_DATABASE_URL` | Local: same server as `DB_URL`, database `clothseeker_test` | Tests only | `pnpm test:integration` |
| `SEED_DEMO_PASSWORD` | You (default `clothseeker-demo`) | Local only | `pnpm db:seed`, E2E |
| `PAYMENT_PROVIDER` | `mock` (only option so far) | **Server-only** | Checkout |
| `MOCK_COURIER_WEBHOOK_SECRET` | Random, ≥ 32 chars (`pnpm env:local` generates one) | **Server-only** | Signing/verifying courier webhooks |
| `MOCK_PAYMENT_WEBHOOK_SECRET` | Random, ≥ 32 chars (`openssl rand -hex 32`; `pnpm env:local` generates one) | **Server-only** | Signing/verifying payment webhooks |

All variables are validated with Zod in `lib/env/schema.ts`. A missing or invalid variable fails fast, and the error names the variable without printing its value. Only `NEXT_PUBLIC_*` variables can reach the browser. `lib/env/server.ts` imports `server-only`, so importing it from a Client Component breaks the build.

## 5. Verify connections

```bash
pnpm db:check        # PASS/FAIL for env, Postgres, row level security, each bucket (and that it is private)
pnpm worker:check    # worker connects, logs worker.db_connected, exits 0
```

With the app running, `curl http://localhost:3000/api/health` should return `{"ok":true,"db":"up"}`.

## 6. Migrate and seed

```bash
pnpm db:migrate
pnpm db:seed
```

The seed is idempotent, and it resets demo passwords and catalog stock. It creates:
- `admin@clothseeker.test` (admin) and `ava@`, `noah@`, `mia@example.test` (customers), all with the password from `SEED_DEMO_PASSWORD`
- 5 categories, 15 dresses (plus 1 hidden draft) and 5 customizable templates

It refuses to run against a non-local database unless you pass `-- --allow-remote`.

## 7. Run

```bash
pnpm dev       # terminal 1: http://localhost:3000 and /admin
pnpm worker    # terminal 2: background worker (Ctrl+C stops it gracefully)
```

Supabase Studio: http://127.0.0.1:55423. Emails sent by local Auth: http://127.0.0.1:55424.

## 8. Test

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm exec playwright install chromium   # once
pnpm test:integration                   # real Postgres, separate clothseeker_test database
pnpm test:e2e                           # starts `pnpm dev` itself, or reuses a server on :3000
pnpm build
```

`pnpm check` runs lint, typecheck, unit tests and build in sequence.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Invalid or missing server environment variables: X` | Run `pnpm env:local --force`, or set `X` from `.env.example` |
| `db:check` FAIL postgres | Is Docker running? `pnpm db:status`. Is `DATABASE_URL` on port 55422? |
| `db:check` FAIL bucket … missing | Buckets are created on start: `pnpm db:stop && pnpm db:start` |
| Port 554xx already in use | Another stack with the same ports is running. Change the ports in `supabase/config.toml`, then `pnpm env:local --force` |
| `Cannot find module '@/lib/generated/prisma/client'` | `pnpm db:generate` |
| Integration tests: `TEST_DATABASE_URL is missing` | `pnpm env:local --force`, or add it from `.env.example` |
| Demo sign-in fails | `pnpm db:seed` (resets demo passwords) |
| Playwright: browser not found | `pnpm exec playwright install chromium` |
