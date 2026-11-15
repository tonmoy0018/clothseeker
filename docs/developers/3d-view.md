# 3D view

"3D view" sits beside "Live mirror" on product pages and on the design screen (and in its tool rail). It shows the garment as a 3D model the customer can turn and zoom: a ready-made item, or their design as it is in the editor. Added 2026-11-15.

It's a quick AI guess from one front picture, and it says so: the front follows the garment, the back and sides are invented.

## How it works

1. **The page** (`app/(shop)/_model-3d/garment-3d-view.tsx`, a full-screen panel) calls `startGarmentModelAction` with the same source a try-on uses (`{ kind: "product", productId }` or `{ kind: "design", spec, designId }`). Signed-out visitors are asked to sign in; it's for customer accounts.
2. **The app** (`lib/model3d/service.ts`, `createGarmentModelJob`) revalidates the design against the live template (`checkDesign`), or checks that the item has a try-on picture, and queues a `GARMENT_MODEL` job (`lib/model3d/payload.ts`). Like other AI jobs:
   - cached by input hash: the same garment for the same customer hands back the model already made (or the job still making it) without a new job;
   - **5 a day** per customer (`MODEL3D_DAILY_LIMIT`, Dhaka day, failed jobs don't count), under the per-customer advisory lock, plus the shared 30 AI requests a day; refusals are recorded for the AI metrics page (`GARMENT_MODEL`).
3. **The worker** (`lib/ai/worker/garment-model.ts`) makes the garment's picture exactly as for a try-on (`garmentImage` in `try-on.ts`), but keeps its transparent cut-out: the design rendered flat and cut out by its region masks, or the catalogue photo with mannequin and backdrop removed. `GarmentModelProvider.buildModel` turns that into a GLB.
4. **Untrusted output:** `checkGlb` (`lib/model3d/glb.ts`) accepts only a self-contained glTF 2.0 binary: right header and chunks, at most 20 MB and 1 000 000 vertices, and no `uri` in buffers or images (a model can't make the viewer fetch from another site). Anything else is a retryable provider failure; nothing is stored.
5. The model is stored privately in `design-assets` under `{customerId}/models/` (`.glb`, `model/gltf-binary`) and the job's result is `{ modelKey }`. Models show a garment, not the customer, so they're kept.
6. **The page** polls `getGarmentModelStatusAction` every 2 s; the status signs the model only for its owner (key under their `models/`). `<model-viewer>` (`@google/model-viewer`, with three.js) loads it from the signed link, with turn, zoom and a slow turntable.

Failures tell the customer "The 3D view couldn't be made this time. Please try again in a minute." (or that the garment can't be shown, when it's no longer available).

## Providers (`MODEL3D_PROVIDER`, worker only)

- **`fake`** (default; development, tests, CI): `FakeGarmentModel` bulges the picture into a card, a front and a back curving out from the outline, cut by the picture's alpha. Deterministic and instant.
- **`local`**: TripoSR (Stability AI and Tripo AI, MIT) on the worker's own machine, in a Python process the worker keeps loaded (`worker/local-3d/triposr_server.py`, started through the shared `PythonModelProcess`, `lib/ai/providers/python-model.ts`, like the local try-on). It predicts a triplane NeRF from the picture and makes a coloured mesh by marching cubes (resolution 192, about 30 000 vertices, a 1 MB GLB).
  - **Speed on the 8 GB Mac:** about 14 s a model once loaded; the first after a start takes about 25–30 s (loading). End to end in the browser, 20–40 s.
  - **Memory:** the transformer runs in half precision on the GPU (MPS) with attention one head at a time; the mesh is made on the CPU with a CPU copy of the small decoder. About 3 GB at peak. It takes its turn in memory with the local planner and try-on (`ModelSlot`).
  - It gets no worker secrets and runs offline (`HF_HUB_OFFLINE=1`); the DINO encoder's config is read from the checked file instead of downloaded.
  - The mesh is turned so its front faces the viewer's first look (TripoSR's own demo opens on the back).

### Setting up the local model

```sh
pnpm model3d:setup      # then set MODEL3D_PROVIDER=local in .env.local and restart the worker
```

`scripts/setup-local-3d.ts`, pinned in `lib/ai/providers/model3d-local-setup.ts`:

- a Python 3.11 virtual environment with pinned packages (PyTorch 2.6, transformers 4.35, trimesh, PyMCubes…; uv if installed);
- TripoSR's code at commit `107cefd`, fetched with git, which checks it by its hash. `worker/local-3d/shim/` stands in for `torchmcubes` (PyMCubes does the same marching cubes without a C++ build) and `rembg` (never used: the garment arrives cut out);
- the weights from Hugging Face at a pinned revision, checked against their SHA-256. TripoSR's `model.ckpt` is a PyTorch pickle: the setup loads it with PyTorch's safe loader (`weights_only=True`, tensors only) and writes `model.safetensors`, then deletes the pickle. The model process only reads safetensors.

Everything goes to `~/.cache/clothseeker/local-3d` (or `LOCAL_3D_DIR`), never into the project (it's on iCloud). About 1.7 GB of weights and 1 GB of packages. Run it again safely: what's in place is kept. The worker refuses to start with `MODEL3D_PROVIDER=local` until the setup has finished.

**Storage:** `design-assets` must allow `model/gltf-binary` (in `supabase/config.toml`). A local stack started before 2026-11-15 needs its bucket updated once (or a restart of the `clothseeker-p1` stack):

```sh
curl -X PUT "$NEXT_PUBLIC_SUPABASE_URL/storage/v1/bucket/design-assets" \
  -H "Authorization: Bearer $SUPABASE_SECRET_KEY" -H "apikey: $SUPABASE_SECRET_KEY" -H "Content-Type: application/json" \
  -d '{"public":false,"file_size_limit":10485760,"allowed_mime_types":["image/png","image/jpeg","image/webp","application/pdf","model/gltf-binary"]}'
```

## Limits

- One front picture: the back is a guess (often a blurred copy of the front's colours), thin parts like straps can break up, and prints soften. It's a preview to turn round, not a pattern.
- A catalogue photo's mannequin hands or stand, when the cut-out keeps them, appear in the model (the Cotton Panjabi's hands).
- The model is rigid: no draping or movement (the live mirror does that in 2D).
- The worker's machine must be on; with the fake provider the "model" is the flat card.

## Tests

- `tests/unit/model3d.test.ts`: the GLB writer and checker (refuses outside files, wrong versions, size, no vertices), the fake, the local provider with a stub runner, and the TripoSR process (arguments, offline, no keys).
- `tests/integration/model3d.test.ts`: queueing, caching, the daily limit, ownership, designs revalidated, unusable provider output stored nowhere, no provider.
- `tests/e2e/model3d.spec.ts` (`@supabase`): sign-in prompt, then a product and a design load in the viewer (fake provider).
