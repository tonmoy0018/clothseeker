# ClothSeeker

The online store of ClothSeeker, a single clothing brand (an academic but realistic prototype). Customers shop ready-made dresses, customize ClothSeeker templates by hand or with AI, try designs on virtually, and request quotes for special tailoring. The ClothSeeker team runs the catalog, orders and production from `/admin`.

**Status: Phase 7 complete.** Customers can sign up or sign in, browse and filter dresses, Buy now, and pay with a mock payment. Customers can also design their own version of customizable dresses (colors, patterns, text, decorations, their own images) with a live price, save designs and add them to the cart. The AI design box turns a short description (and up to 3 photos) into four design ideas that can be picked, refined ("like option 2 but darker") or regenerated, up to 10 rounds a day. The worker does the AI work, with deterministic fake providers by default and Gemini / Cloudflare Workers AI behind env vars. Customers can also start a design from a photo of a dress or a description (`/design/start`), and try designs or ready-made dresses on a photo of themselves (a rough AI preview, consent first, unsaved photos deleted after 24 h). Photo-started designs that need special tailoring can get a quote: the team replies with a price within 24 hours in `/admin/quotes`, the price is valid for 7 days, and a paid quote goes straight to production. Checkout takes a delivery address, sends customers to a simulated payment gateway, and confirms orders through a signed webhook; customers can track each order's progress. The team works orders from `/admin/orders`: accept or decline custom designs (declined or overdue items are refunded automatically), print production spec sheets, record QC photos, ship and follow simulated courier updates. The ClothSeeker team manages dresses, sizes and colors, stock, photos and customization templates in `/admin`. Pages for later phases are placeholders that name the phase that will build them. See [CLAUDE.md](CLAUDE.md) for the product contract and phase plan.

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
| `pnpm test:e2e` | Playwright tests (Buy now, admin catalog, design screen; needs local Supabase + seed). Builds and starts production first. First time: `pnpm exec playwright install chromium` |
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
| `pnpm db:seed` | Run `prisma/seed.ts` (also restores the demo dresses' stock) |
| `pnpm db:clean-test` | Remove accounts and dresses left by tests from the local database (`--dry-run` to preview) |

`GET /api/health` returns `{"ok":true,"db":"up"}` when the app can reach the database, or 503 otherwise.

## Documentation

- [docs/developers/local-setup.md](docs/developers/local-setup.md): setup in detail, environment variables, troubleshooting
- [docs/developers/architecture.md](docs/developers/architecture.md): how the pieces fit together
- [docs/developers/data-model.md](docs/developers/data-model.md): tables, lifecycle, row level security
- [docs/developers/permissions-matrix.md](docs/developers/permissions-matrix.md): who can do what
- [docs/developers/testing.md](docs/developers/testing.md): unit, integration and E2E tests
- [docs/developers/media-uploads.md](docs/developers/media-uploads.md): image upload pipeline and limits
- [docs/developers/design-spec.md](docs/developers/design-spec.md) and [rendering.md](docs/developers/rendering.md): custom designs and print files
- [docs/developers/order-lifecycle.md](docs/developers/order-lifecycle.md) and [payments.md](docs/developers/payments.md): checkout, webhooks, order states
- [docs/developers/licences.md](docs/developers/licences.md): third-party licences (**AGPL note for background removal**)
- [docs/developers/production.md](docs/developers/production.md): production, QC, shipping, refunds
- [docs/developers/ai-pipelines.md](docs/developers/ai-pipelines.md): AI design box, photo/description starts, providers, quota, cache, worker jobs
- [docs/developers/try-on.md](docs/developers/try-on.md): virtual try-on, consent and privacy, 24-hour cleanup, feasibility results
- [docs/admin/catalog.md](docs/admin/catalog.md), [docs/admin/orders.md](docs/admin/orders.md) and [docs/admin/quotes.md](docs/admin/quotes.md): guides for the ClothSeeker team
- Customer and team (admin) guides arrive in Phase 10.
