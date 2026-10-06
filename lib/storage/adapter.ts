import type { BucketName } from "./buckets";

// Storage behind an interface so services can be tested without Supabase
// and the provider can be swapped (CLAUDE.md: keep integrations replaceable).

export interface StorageAdapter {
  /** Stores a new object. Never overwrites: keys are server-generated and unique. */
  put(bucket: BucketName, key: string, data: Buffer, contentType: string): Promise<void>;
  /** Deletes objects; missing keys are ignored. */
  remove(bucket: BucketName, keys: readonly string[]): Promise<void>;
  /** Short-lived read URLs for private objects. Keys that can't be signed are omitted. */
  signReadUrls(bucket: BucketName, keys: readonly string[], ttlSeconds?: number): Promise<Map<string, string>>;
}

export const DEFAULT_SIGNED_URL_TTL_SECONDS = 3600;
