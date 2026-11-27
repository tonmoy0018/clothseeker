# Deployment (the live ClothSeeker)

The live shop runs on free tiers: the Next.js app on **Vercel Hobby** (Mumbai, `bom1`), the database, sign-in and storage on a hosted **Supabase** project (Mumbai, `ap-south-1`, project ref `nstrxbvjwdziizufznps`), and the job worker on the **Mac mini** (`pnpm worker:hosted`). Mumbai is the closest region to Dhaka on both, and the app and its database sit next to each other.

| | Where | Set up by |
|---|---|---|
| App | Vercel project `cloth-seekers/clothseeker`; once connected to the GitHub repo, every push to `main` deploys | `vercel.json` (region), Vercel environment variables |
| Database, Auth, Storage | Supabase project `clothseeker` (organisation "ClothSeeker") | `prisma migrate deploy`, `supabase/config.toml` (`[remotes.production]`) |
| Worker (AI jobs, emails, sweeps) | The Mac mini, only while it's on | `pnpm worker:hosted` |

## The production env file

Production secrets live in **`.env.hosted.nosync`** at the repo root, on the Mac mini only:

- git ignores it (`.env*`), and iCloud never syncs `*.nosync` files (the repo is on an iCloud Desktop);
- it is **not** called `.env.production.local`: Next.js, Prisma and the worker would load that file on their own, and point local work at the live database;
- `pnpm hosted <command>` (`scripts/hosted.ts`) runs a command with its values set first, so they win over `.env.local`; anything it leaves out (e.g. the AI providers) still comes from `.env.local`. It refuses to run without the file or with a local `DATABASE_URL`.

| Variable | Value |
|---|---|
| `SUPABASE_DB_PASSWORD` | The database password, generated when the project was created |
| `NEXT_PUBLIC_APP_URL` | `https://clothseeker.vercel.app` |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://nstrxbvjwdziizufznps.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` | `supabase projects api-keys --project-ref … --reveal` (without `--reveal` the secret key comes back masked, and Supabase answers "Invalid API key") |
| `DATABASE_URL` | The **transaction** pooler, port 6543 (`postgres.<ref>@aws-1-ap-south-1.pooler.supabase.com:6543/postgres`): for the app's many short-lived functions |
| `DIRECT_URL` | The **session** pooler, port 5432, same host: for migrations. (The direct `db.<ref>.supabase.co` address is IPv6-only on the free plan.) |
| `PAYMENT_PROVIDER`, `MOCK_PAYMENT_WEBHOOK_SECRET`, `MOCK_COURIER_WEBHOOK_SECRET` | `mock`, and two fresh `openssl rand -hex 32` values (never the local ones) |
| `SEED_DEMO_PASSWORD` | A random password for the seeded accounts, including `admin@clothseeker.test`. Never the public `clothseeker-demo`. |
| `EMAIL_PROVIDER` | `log`: the live site sends no emails yet (Mailpit is local only) |

The Vercel project has the app's variables (everything above except `SUPABASE_DB_PASSWORD`, `DIRECT_URL`, `SEED_DEMO_PASSWORD` and `EMAIL_PROVIDER`), added as **sensitive** production variables.

## Updating the live site

- **Code:** merge to `main`; Vercel builds and deploys it (once GitHub is connected, see below; until then `npx --yes vercel@65.15.0 deploy --prod --scope cloth-seekers` from the Mac). The build downloads the on-device vision models (`prebuild`, about 99 MB, checked by SHA-256).
- **Database changes:** apply the migration **before** merging the code that needs it: `pnpm hosted prisma migrate deploy`. Migrations only add, so the running site keeps working in between.
- **Sign-in settings and buckets** (`supabase/config.toml`): `pnpm exec supabase config diff --project-ref nstrxbvjwdziizufznps`, then `config push` with the same ref. New buckets: `pnpm exec supabase seed buckets --linked` (after `supabase link --project-ref …`). The `[remotes.production]` block keeps the live site address, Supabase's email spacing and the free plan's pool sizes.
- **Catalogue:** the team edits it in `/admin` on the live site. `pnpm hosted tsx prisma/seed.ts --allow-remote` re-runs the (idempotent) seed: it restores the demo dresses' stock and never overwrites photos the team uploaded.

## The worker

The live site queues AI design rounds, try-ons, 3D views, emails and the timeout sweeps (payment expiry, 24-hour acceptance, quotes, try-on cleanup) in its own database. Only a worker connected to it runs them:

```bash
pnpm worker:hosted
```

It uses the AI providers from `.env.local` (the file sets none). While it's off, live customers' AI jobs wait in the queue (they survive restarts) and the sweeps catch up when it starts. The local worker (`pnpm worker`) serves only the local database. Both on the 8 GB Mac compete for memory when they load the local models (try-on, planner, 3D): run one at a time.

## One-time setup (done on 2026-11-27, for the record)

1. `supabase login`; `supabase orgs create ClothSeeker`; `supabase projects create clothseeker --org-id … --region ap-south-1 --db-password …`.
2. `supabase link --project-ref …`; the pooler address is in `supabase/.temp/pooler-url`.
3. `.env.hosted.nosync` as above; `pnpm hosted prisma migrate deploy`; `supabase config push`; `supabase seed buckets --linked`; `pnpm hosted tsx prisma/seed.ts --allow-remote`.
4. `vercel login` (team "ClothSeekers", `cloth-seekers`); `vercel link --yes --project clothseeker --scope cloth-seekers` (it also writes a `VERCEL_OIDC_TOKEN` into `.env.local`, which nothing uses: delete it); `vercel domains add clothseeker.vercel.app clothseeker`; the environment variables (`vercel env add NAME --environment production --sensitive --yes`, values piped from the file, never typed), plus `ENABLE_EXPERIMENTAL_COREPACK=1` so Vercel installs with the pinned `pnpm@12.8.1`; `vercel deploy --prod`.
   - **`.vercelignore`**: the CLI doesn't read `.gitignore`. Without it, the first deploy tried to upload the local build (1.4 GB), the downloaded models and the `.env` files; the 100 MB upload limit stopped it before anything was sent. Keep it in step with `.gitignore`.
   - **GitHub:** `vercel git connect` needs the Vercel GitHub app installed on the repo's account (https://github.com/apps/vercel). Until then, deploy from the Mac with `npx --yes vercel@65.15.0 deploy --prod --scope cloth-seekers`.
5. The repo's website field: `gh repo edit --homepage https://clothseeker.vercel.app`.

## Limits

- **Vercel Hobby is for non-commercial use**, one region, 4.5 MB request bodies (uploads are capped at 4 MB for this).
- **A free Supabase project pauses after a week without activity**; restore it from the Supabase dashboard. Free storage is 1 GB and the database 500 MB.
- **Anyone can sign up.** Payments are the mock gateway (no money moves); emails are only logged.
- **Privacy:** the live site uses the same AI providers as `.env.local`. Gemini's free tier may use submitted prompts and photos to improve Google's products, and with `GARMENT_SHOT_PROVIDER`/`SKETCH_PROVIDER=cloudflare` customers' photos and drawings go to Cloudflare. Disclose this (or switch to paid tiers) before real customers use AI photo features. Try-on photos stay on our systems (Supabase and the Mac mini).
