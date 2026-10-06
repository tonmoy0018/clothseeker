// Keep in sync with [storage.buckets.*] in supabase/config.toml. All buckets are private.

export const BUCKETS = {
  /** Catalog product photos and template garment images (Phase 2). */
  productMedia: "product-media",
  /** Customer design uploads, renders and print files (Phase 3+). */
  designAssets: "design-assets",
  /** Production QC evidence photos (Phase 5). */
  qcPhotos: "qc-photos",
  /** Try-on photos and results; unsaved objects deleted after 24h (Phase 7). */
  tryonPrivate: "tryon-private",
} as const;

export type BucketName = (typeof BUCKETS)[keyof typeof BUCKETS];

/** Allowed file extensions per bucket. Content type is also checked by Supabase Storage. */
export const BUCKET_EXTENSIONS: Record<BucketName, readonly string[]> = {
  "product-media": ["png", "jpg", "jpeg", "webp"],
  "design-assets": ["png", "jpg", "jpeg", "webp", "pdf"],
  "qc-photos": ["png", "jpg", "jpeg", "webp"],
  "tryon-private": ["png", "jpg", "jpeg", "webp"],
};
