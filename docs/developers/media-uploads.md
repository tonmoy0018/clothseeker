# Media uploads

All uploaded images are **untrusted**. Every upload goes through one pipeline before it is stored.

## Pipeline ([`lib/media/process-image.ts`](../../lib/media/process-image.ts))

1. **Size check.** Uploads over 4 MB are rejected before decoding. Vercel Hobby rejects request bodies over 4.5 MB, and `next.config.ts` sets the server-action body limit to 4.4 MB to match.
2. **Real format detection.** The bytes are decoded with `sharp` (with `limitInputPixels`). Only **JPEG, PNG and WebP** are accepted. The filename and the browser's MIME type are ignored. libvips can also read SVG, PDF, TIFF and GIF, but these are rejected explicitly. SVG in particular can carry scripts.
3. **Dimension rules** per purpose:

   | Purpose | Minimum edge | Stored at most |
   |---|---|---|
   | Product photo | 600 px | 2000 px |
   | Garment template image | 800 px | 2000 px |
   | Style reference image | 300 px | 1000 px |

   Inputs larger than 8000 px on either side are rejected.
4. **Normalize.** The image is auto-rotated using EXIF orientation, resized, and **re-encoded to WebP**. Re-encoding drops all metadata (EXIF, GPS, camera, author).
5. **Server-generated key.** Keys look like `{productId}/{photos|template|style}/{uuid}.webp` ([`buildObjectKey`](../../lib/storage/object-key.ts)). The original filename is never stored.

## Storage

- Behind [`StorageAdapter`](../../lib/storage/adapter.ts): `SupabaseStorageAdapter` (server-only, secret key) in the app, `MemoryStorageAdapter` in tests.
- All buckets are **private** with no storage policies. The publishable key can't list, read or upload (see [testing.md](testing.md)). Images reach browsers only as **signed URLs** (1 h), batched per page in [`lib/catalog/images.ts`](../../lib/catalog/images.ts) and only for products the viewer may see.
- **Cleanup:**
  - Removing a photo deletes its object.
  - Saving a template deletes images it no longer references.
  - A failed database write after an upload deletes the new object.
  - Images uploaded in the template editor but never saved stay as orphans. A cleanup job is planned for Phase 9.

## Free-tier notes

- Signed URLs change on every page view, so browsers and CDNs can't cache images across visits. That's acceptable for a prototype. A public "catalog" bucket with a CDN is the production alternative.
- `next/image` is used with `unoptimized` because the URLs are signed and short-lived.
