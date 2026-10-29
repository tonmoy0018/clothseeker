# Third-party licences to keep in mind

Most dependencies use permissive licences (MIT, Apache-2.0, BSD, ISC). These ones need attention.

| Component | Licence | Where | What it means |
|---|---|---|---|
| `@imgly/background-removal` | **AGPL-3.0** | Optional "Remove background" on the design screen (browser only, loaded on demand) | If the app is offered publicly, its **complete source code must be made available** to users under the AGPL. That's fine for an open academic project. **Before a closed-source commercial launch, either buy IMG.LY's commercial licence or remove/replace this feature** (e.g. with a server-side model behind a provider interface). The feature also downloads its model (~40 MB) from IMG.LY's CDN on first use. |
| Fonts in `public/fonts/` | SIL OFL 1.1 / Apache-2.0 | Text layers, print files | Embedding in print files is allowed. Keep the licence files next to the fonts, and don't sell the fonts on their own. |
| `nodemailer` | MIT-0 | Worker: sends customer emails over SMTP | Permissive; no action needed. |
| `@gradio/client` | ISC | Worker only: calls the try-on Spaces | Permissive; no action needed. |
| Try-on models on Hugging Face Spaces (IDM-VTON, OOTDiffusion, Leffa) | Per Space/model (research licences, some **non-commercial**: IDM-VTON is CC BY-NC-SA 4.0) | Worker, only when `TRYON_PROVIDER=huggingface` | We call public demo Spaces; we don't ship the models. Check each model's licence and the Space's terms **before any commercial use**, and replace them with a licensed or self-hosted model if needed. |
| `onnxruntime-web` | MIT | Browser: runs the on-device vision models ([live-try-on.md](live-try-on.md)) | Permissive; no action needed. |
| On-device vision models: MoveNet Lightning (`Xenova/movenet-singlepose-lightning`), selfie segmentation (`onnx-community/mediapipe_selfie_segmentation`), YuNet (`opencv/face_detection_yunet`) | Apache-2.0, Apache-2.0, MIT | Served from `public/vision/` (downloaded by `pnpm vision:fetch`, not committed) | Permissive; commercial use allowed. Keep their licence notices if the files are redistributed. |
| `sharp` / libvips | Apache-2.0 / LGPL-3.0 | Server image processing | LGPL is satisfied by dynamic linking via the prebuilt binaries. No action needed. |
| Sample dress photos in `prisma/seed-photos/` and style pictures in `prisma/style-photos/` | FLUX.1 schnell outputs (model: Apache-2.0) | Seed data: catalog photos for the 15 demo dresses | AI-generated with Cloudflare Workers AI; free to use. They're samples, not photos of real garments: replace them with real product photos before launch. |
