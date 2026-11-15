# lib/ai

The AI features: the design box, starting from a photo or description, and virtual try-on. Read [docs/developers/ai-pipelines.md](../../docs/developers/ai-pipelines.md) and [try-on.md](../../docs/developers/try-on.md) first.

- `types.ts`: provider interfaces: `PlannerProvider` (plans, brand-logo and try-on photo checks, dress matching), `ImageProvider`, `TryOnProvider`, `SketchRenderer` and `GarmentModelProvider` (the 3D view).
- `providers/` holds the implementations: `fake.ts` (the default everywhere), `gemini.ts`, `cloudflare.ts`, `tryon-hf.ts`, `tryon-local.ts` (with `tryon-local-setup.ts`), `model3d-local.ts` (TripoSR, with `model3d-local-setup.ts`) and `photo-check-local.ts`; `python-model.ts` runs the local Python models; `http.ts` is their shared fetch helper. `index.ts` picks them from the worker env.
- `jobs.ts` (design rounds) and `starts.ts` (photo/description starts) are the app side: queue, quota, cache and poll. They never call a provider.
- `plan.ts` and `match.ts` turn untrusted planner JSON into template-valid DesignSpecs.
- `worker/` holds claiming, retries and timeouts (`run.ts`) and one pipeline per job type.

Only the worker calls providers, never the browser or a request handler.
