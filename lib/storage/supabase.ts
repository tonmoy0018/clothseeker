import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

import { DEFAULT_SIGNED_URL_TTL_SECONDS, type StorageAdapter } from "./adapter";
import type { BucketName } from "./buckets";
import { assertSafeObjectKey } from "./object-key";

const MAX_TTL_SECONDS = 24 * 3600;

/**
 * Supabase Storage with the secret key. Callers MUST authorize the request first:
 * this adapter bypasses storage policies (buckets are private with no public policies).
 */
export class SupabaseStorageAdapter implements StorageAdapter {
  async put(bucket: BucketName, key: string, data: Buffer, contentType: string): Promise<void> {
    assertSafeObjectKey(key);
    const { error } = await createSupabaseAdminClient()
      .storage.from(bucket)
      .upload(key, data, { contentType, upsert: false, cacheControl: "3600" });
    if (error) {
      throw new Error(`Storage upload failed for bucket ${bucket}`);
    }
  }

  async remove(bucket: BucketName, keys: readonly string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    keys.forEach(assertSafeObjectKey);
    const { error } = await createSupabaseAdminClient().storage.from(bucket).remove([...keys]);
    if (error) {
      throw new Error(`Storage delete failed for bucket ${bucket}`);
    }
  }

  async signReadUrls(
    bucket: BucketName,
    keys: readonly string[],
    ttlSeconds: number = DEFAULT_SIGNED_URL_TTL_SECONDS,
  ): Promise<Map<string, string>> {
    const urls = new Map<string, string>();
    const safeKeys = keys.filter((key) => {
      try {
        assertSafeObjectKey(key);
        return true;
      } catch {
        return false;
      }
    });
    if (safeKeys.length === 0) {
      return urls;
    }
    const ttl = Math.min(Math.max(Math.floor(ttlSeconds), 60), MAX_TTL_SECONDS);
    const { data, error } = await createSupabaseAdminClient().storage.from(bucket).createSignedUrls(safeKeys, ttl);
    if (error || !data) {
      return urls;
    }
    for (const entry of data) {
      if (entry.path && entry.signedUrl && !entry.error) {
        urls.set(entry.path, entry.signedUrl);
      }
    }
    return urls;
  }
}

let instance: SupabaseStorageAdapter | undefined;

export function getStorage(): StorageAdapter {
  instance ??= new SupabaseStorageAdapter();
  return instance;
}
