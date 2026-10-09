# lib/ai

The AI design box. Read [docs/developers/ai-pipelines.md](../../docs/developers/ai-pipelines.md) first.

- `types.ts`: the provider interfaces (`PlannerProvider`, `ImageProvider`). `TryOnProvider` arrives in Phase 7.
- `fake.ts` / `gemini.ts` / `cloudflare.ts`: implementations. `index.ts` picks them from the worker env.
- `jobs.ts`: the app side (queue, quota, cache, poll, pick). It never calls a provider.
- `plan.ts`: untrusted planner JSON → template-valid DesignSpecs.
- `worker/`: claiming, retries and timeouts (`run.ts`), and the design-round pipeline.

Only the worker calls providers, never the browser or a request handler.
