import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

import type { BucketName } from "./buckets";
import { assertSafeObjectKey } from "./object-key";

const DEFAULT_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 3600;

/**
 * Short-lived read URL for a private object. The caller MUST have already authorized
 * access to the resource that owns this key (role + ownership).
 */
export async function createSignedReadUrl(
  bucket: BucketName,
  key: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<string> {
  assertSafeObjectKey(key);
  const ttl = Math.min(Math.max(Math.floor(ttlSeconds), 1), MAX_TTL_SECONDS);
  const { data, error } = await createSupabaseAdminClient().storage.from(bucket).createSignedUrl(key, ttl);
  if (error) {
    throw new Error(`Could not sign storage URL for bucket ${bucket}`);
  }
  return data.signedUrl;
}
