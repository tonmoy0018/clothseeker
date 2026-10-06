# ClothSeeker

An academic but realistic custom-clothing marketplace: a customer shop (ready-made dresses, template customization, AI-assisted design, optional virtual try-on, quotes), a seller portal, and an admin tool.

**Status: Phase 0 (skeleton).** Pages are placeholders that name the phase that will implement them. See [CLAUDE.md](CLAUDE.md) for the full product contract and phase plan.

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
pnpm db:migrate              # apply Prisma migrations (none until Phase 1)
pnpm db:seed                 # seed demo data (stub until Phase 1)
pnpm dev                     # app at http://localhost:3000
pnpm worker                  # background worker, in a second terminal
```

Local Supabase uses ports **55420–55429** (API 55421, Postgres 55422, Studio http://127.0.0.1:55423, Mailpit 55424). They're offset from the Supabase defaults so this project can run alongside other local Supabase projects.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Next.js dev server |
| `pnpm build` / `pnpm start` | Production build / serve it |
| `pnpm lint` | ESLint (no `any`, no `@ts-ignore`, no inline disables) |
| `pnpm typecheck` | Generate route types, then `tsc --noEmit` |
| `pnpm test` | Vitest unit tests (`tests/unit`) |
| `pnpm test:e2e` | Playwright smoke tests (`tests/e2e`). First time: `pnpm exec playwright install chromium` |
| `pnpm check` | lint + typecheck + unit tests + build |
| `pnpm worker` | Run the worker until Ctrl+C |
| `pnpm worker:check` | Worker connects to the database, then exits |
| `pnpm db:start` / `db:stop` / `db:status` | Manage local Supabase |
| `pnpm env:local` | Write `.env.local` from local Supabase (`--force` to overwrite) |
| `pnpm db:check` | Check env, Postgres and storage buckets |
| `pnpm db:generate` | Regenerate the Prisma client |
| `pnpm db:migrate` | Create/apply migrations in development |
| `pnpm db:deploy` | Apply committed migrations (CI / production) |
| `pnpm db:seed` | Run `prisma/seed.ts` |

`GET /api/health` returns `{"ok":true,"db":"up"}` when the app can reach the database, or 503 otherwise.

## Documentation

- [docs/developers/local-setup.md](docs/developers/local-setup.md): setup in detail, environment variables, troubleshooting
- [docs/developers/architecture.md](docs/developers/architecture.md): how the pieces fit together
- Customer, seller and admin guides arrive in Phase 10.
