import "server-only";

import { BUCKETS } from "@/lib/storage/buckets";
import { getStorage } from "@/lib/storage/supabase";

/**
 * Signed URLs for catalog photos (private bucket), one batched call per page.
 * Only call this with keys of products the viewer is allowed to see (ACTIVE in the shop).
 */
export async function signCatalogImages(keys: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(keys.filter((k): k is string => typeof k === "string"))];
  if (unique.length === 0) {
    return new Map();
  }
  try {
    return await getStorage().signReadUrls(BUCKETS.productMedia, unique);
  } catch {
    // Photos are decorative here: fall back to illustrations if storage is unavailable.
    return new Map();
  }
}
