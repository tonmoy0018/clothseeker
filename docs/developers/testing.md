# Testing

| Suite | Command | Needs | What it covers |
|---|---|---|---|
| Unit | `pnpm test` | nothing | Pure rules: auth policy, `safeNextPath`, money, catalog filters, template schema, order numbers, mock payments, env and storage keys |
| Integration | `pnpm test:integration` | Postgres (`TEST_DATABASE_URL`) | Domain services against a real database: cart rules, ownership, checkout idempotency, stock, RLS |
| E2E (all) | `pnpm test:e2e` | local Supabase + seed; starts the worker | Smoke tests plus the `@supabase` journeys (buy now, design, checkout, production, AI design box) |
| E2E (CI subset) | `pnpm test:e2e:ci` | Postgres only | Smoke tests that need no sign-in or seed data |

`pnpm check` runs lint, typecheck, unit tests and the build.

## Integration tests

- They run in a **separate database**, `clothseeker_test`, on the local Supabase Postgres (`TEST_DATABASE_URL`, written by `pnpm env:local`). Your dev data is never touched.
- [`tests/integration/global-setup.ts`](../../tests/integration/global-setup.ts) creates the database if it's missing and runs `prisma migrate deploy` on it.
- As a safety check, the database name **must end in `_test`**, or the suite refuses to run.
- Each test file truncates all tables before every test (`resetDatabaseBeforeEach()`). Files run one at a time.
- Factories are in [`tests/integration/helpers.ts`](../../tests/integration/helpers.ts): `createUser(role)` and `createProduct({ variants })`.
- `.env.local` is loaded with `process.loadEnvFile`, because `@next/env` skips `.env.local` when `NODE_ENV=test`.

## E2E tests

- Locally, Playwright also starts **the worker** (`pnpm worker`) and waits for `GET http://127.0.0.1:3101/health` (`WORKER_HEALTH_PORT`). It forces the fake AI providers (`PLANNER_PROVIDER=fake`, `IMAGE_PROVIDER=fake`, `AI_FAKE_DELAY_MS=800`) whatever `.env.local` says. A worker you already run alongside is harmless, because job claiming is safe for several workers.
- The AI tests (`tests/e2e/ai.spec.ts`) sign up a fresh customer each, so the daily quota of 10 starts full.
- `pnpm test:e2e` **builds and starts a production server** (`pnpm build && pnpm start`), or reuses a server already running on :3000. The dev server compiles routes on first visit, which made parallel runs flaky. Set `E2E_DEV=1` to run against `pnpm dev` instead.
- Production pages render before React hydrates, so tests that click interactive controls right after navigation retry the click until it registers (`expect(...).toPass()`).
- Test runs clean up after themselves: the design test deletes the design it saved, and the admin test archives its dress.
- The `@supabase` journey signs in as the seeded `ava@example.test` and **really places an order**, which reduces stock in your dev database. Run `pnpm db:seed` to reset the catalog.
- The demo password comes from `SEED_DEMO_PASSWORD` (default `clothseeker-demo`).

## CI

`.github/workflows/ci.yml` uses a `postgres:17` service container instead of Supabase. It runs lint → typecheck → unit → `db:deploy` → integration → build → `test:e2e:ci`. Supabase Auth isn't available in CI, so `@supabase` journeys run only locally.

## RLS probe

Confirm that the public API key can read nothing:

```bash
set -a; . ./.env.local; set +a
curl -s "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/products?select=*" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"     # → []
```

## Writing new tests

- Put business rules in `lib/**` services that take `(db, actor, input)`, so they can be tested without Next.js.
- Test the denial path for every new mutation: wrong customer, wrong role, malformed input.
- Never assert on prices sent by the client. The server decides prices.
