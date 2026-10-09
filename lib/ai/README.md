# lib/ai

The AI features: the design box, starting from a photo or description, and virtual try-on. Read [docs/developers/ai-pipelines.md](../../docs/developers/ai-pipelines.md) and [try-on.md](../../docs/developers/try-on.md) first.

- `types.ts`: provider interfaces: `PlannerProvider` (plans, brand-logo and try-on photo checks, dress matching), `ImageProvider` and `TryOnProvider`.
- `fake.ts`, `gemini.ts`, `cloudflare.ts` and `tryon-hf.ts` are the implementations. `index.ts` picks them from the worker env.
- `jobs.ts` (design rounds) and `starts.ts` (photo/description starts) are the app side: queue, quota, cache and poll. They never call a provider.
- `plan.ts` and `match.ts` turn untrusted planner JSON into template-valid DesignSpecs.
- `worker/` holds claiming, retries and timeouts (`run.ts`) and one pipeline per job type.

Only the worker calls providers, never the browser or a request handler.
