# lib/vision

The on-device vision models and everything built on them. Camera frames and photo checks never leave the device: in the browser the models run in a Web Worker, and in the worker they run on our own machine. Read [docs/developers/live-try-on.md](../../docs/developers/live-try-on.md) first.

- `models/`: one file per model, pure: how to build its input and decode its output (`movenet.ts` body points for photos, `rtmpose.ts` body points for the live mirror (and the crop it tracks the person with), `yunet.ts` faces, `segment.ts` the person's outline (selfie model or MODNet matting), `parts.ts` what each pixel of them is: hair, skin, clothes; used by the worker's try-on so far), plus `geometry.ts` (fitting a picture into a model's square input).
- `runtime/`: where the models run. `assets.ts` pins each model file by SHA-256; `engine.ts`, `vision.worker.ts`, `protocol.ts` and `client.ts` are the browser side (ONNX Runtime Web in a Web Worker); `node-vision.ts` is the same for the Node worker.
- `photo/`: try-on photos. `photo-check.ts` holds the rules (shared by browser and worker), `check-photo.ts` and `measure-photo.ts` run them in the browser before upload.
- `mirror/`: the live mirror. `mirror.ts` fits the garment to the body (pure geometry), `cloth.ts` and `smooth.ts` move it, `uncover.ts` and `relight.ts` handle the person's own clothes and the light, `garment-source.ts` and `garment-fill.ts` prepare the garment picture, and `draw.ts` paints the canvas.

Keep fitting and decoding pure and unit-tested; browser-only code (canvas, worker) stays at the edges.
