# Third-party licences to keep in mind

Most dependencies use permissive licences (MIT, Apache-2.0, BSD, ISC). These ones need attention.

| Component | Licence | Where | What it means |
|---|---|---|---|
| `@imgly/background-removal` | **AGPL-3.0** | Optional "Remove background" on the design screen (browser only, loaded on demand) | If the app is offered publicly, its **complete source code must be made available** to users under the AGPL. That's fine for an open academic project. **Before a closed-source commercial launch, either buy IMG.LY's commercial licence or remove/replace this feature** (e.g. with a server-side model behind a provider interface). The feature also downloads its model (~40 MB) from IMG.LY's CDN on first use. |
| Fonts in `public/fonts/` | SIL OFL 1.1 / Apache-2.0 | Text layers, print files | Embedding in print files is allowed. Keep the licence files next to the fonts, and don't sell the fonts on their own. |
| `sharp` / libvips | Apache-2.0 / LGPL-3.0 | Server image processing | LGPL is satisfied by dynamic linking via the prebuilt binaries. No action needed. |
