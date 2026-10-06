# ClothSeeker

The online store of ClothSeeker, a single clothing brand (an academic but realistic prototype). Customers shop ready-made dresses, customize ClothSeeker templates by hand or with AI, try designs on virtually, and request quotes for special tailoring. The ClothSeeker team runs the catalog, orders and production from `/admin`.

**Status: Phase 1 complete.** Customers can sign up or sign in, browse and filter dresses, Buy now, and pay with a mock payment. Pages for later phases are placeholders that name the phase that will build them. See [CLAUDE.md](CLAUDE.md) for the product contract and phase plan.

## Stack

Next.js 16 (App Router) · TypeScript (strict) · Tailwind CSS 4 · shadcn/ui · Supabase (Postgres, Auth, Storage) · Prisma 7 · Zod · Node worker (`tsx`) · Vitest · Playwright. Free tiers only.

## Prerequisites

- Node.js 22.12+ or 24 LTS (Node 26 works, but Prisma prints an "unsupported version" warning)
- pnpm 12 (`corepack enable` picks up the version pinned in `package.json`)
- Docker Desktop, running (for local Supabase)

The Supabase CLI is a dev dependency; no global install needed.

## Quick start

```bash
pnpm install                 # also generates the Prisma client
pnpm db:start                # start local Supabase in Docker (first run downloads images)
pnpm env:local               # write .env.local from the running stack
pnpm db:check                # verify env, Postgres and storage buckets
pnpm db:migrate              # apply Prisma migrations
pnpm db:seed                 # demo accounts + 15 dresses (safe to re-run)
pnpm dev                     # app at http://localhost:3000
pnpm worker                  # background worker, in a second terminal
```

### Demo accounts (local only)

| Email | Role | Password |
|---|---|---|
| `ava@example.test`, `noah@example.test`, `mia@example.test` | customer | `clothseeker-demo` |
| `admin@clothseeker.test` | admin (`/admin`) | `clothseeker-demo` |

The password comes from `SEED_DEMO_PASSWORD` in `.env.local`. The seed refuses to run against a non-local database.

Local Supabase uses ports **55420–55429** (API 55421, Postgres 55422, Studio http://127.0.0.1:55423, Mailpit 55424). They're offset from the Supabase defaults so this project can run alongside other local Supabase projects.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Next.js dev server |
| `pnpm build` / `pnpm start` | Production build / serve it |
| `pnpm lint` | ESLint (no `any`, no `@ts-ignore`, no inline disables) |
| `pnpm typecheck` | Generate route types, then `tsc --noEmit` |
| `pnpm test` | Vitest unit tests (`tests/unit`) |
| `pnpm test:integration` | Service tests against a real Postgres test database (`clothseeker_test`) |
| `pnpm test:e2e` | Playwright tests incl. the Buy now journey (needs local Supabase + seed). First time: `pnpm exec playwright install chromium` |
| `pnpm test:e2e:ci` | Playwright tests that need no sign-in (what CI runs) |
| `pnpm check` | lint + typecheck + unit tests + build |
| `pnpm worker` | Run the worker until Ctrl+C |
| `pnpm worker:check` | Worker connects to the database, then exits |
| `pnpm db:start` / `db:stop` / `db:status` | Manage local Supabase |
| `pnpm env:local` | Write `.env.local` from local Supabase (`--force` to overwrite) |
| `pnpm db:check` | Check env, Postgres, row level security and storage buckets |
| `pnpm db:generate` | Regenerate the Prisma client |
| `pnpm db:migrate` | Create/apply migrations in development |
| `pnpm db:deploy` | Apply committed migrations (CI / production) |
| `pnpm db:seed` | Run `prisma/seed.ts` |

`GET /api/health` returns `{"ok":true,"db":"up"}` when the app can reach the database, or 503 otherwise.

## Documentation

- [docs/developers/local-setup.md](docs/developers/local-setup.md): setup in detail, environment variables, troubleshooting
- [docs/developers/architecture.md](docs/developers/architecture.md): how the pieces fit together
- [docs/developers/data-model.md](docs/developers/data-model.md): tables, lifecycle, row level security
- [docs/developers/permissions-matrix.md](docs/developers/permissions-matrix.md): who can do what
- [docs/developers/testing.md](docs/developers/testing.md): unit, integration and E2E tests
- Customer and team (admin) guides arrive in Phase 10.
