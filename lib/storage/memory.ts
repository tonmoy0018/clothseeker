import type { StorageAdapter } from "./adapter";
import type { BucketName } from "./buckets";
import { assertSafeObjectKey } from "./object-key";

/** In-memory storage for tests. Mirrors the Supabase adapter's key checks. */
export class MemoryStorageAdapter implements StorageAdapter {
  readonly objects = new Map<string, { data: Buffer; contentType: string }>();

  private id(bucket: BucketName, key: string): string {
    return `${bucket}/${key}`;
  }

  async put(bucket: BucketName, key: string, data: Buffer, contentType: string): Promise<void> {
    assertSafeObjectKey(key);
    if (this.objects.has(this.id(bucket, key))) {
      throw new Error("Object already exists");
    }
    this.objects.set(this.id(bucket, key), { data, contentType });
  }

  async get(bucket: BucketName, key: string): Promise<Buffer | null> {
    assertSafeObjectKey(key);
    return this.objects.get(this.id(bucket, key))?.data ?? null;
  }

  async remove(bucket: BucketName, keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      this.objects.delete(this.id(bucket, key));
    }
  }

  async signReadUrls(bucket: BucketName, keys: readonly string[]): Promise<Map<string, string>> {
    const urls = new Map<string, string>();
    for (const key of keys) {
      if (this.objects.has(this.id(bucket, key))) {
        urls.set(key, `memory://${bucket}/${key}`);
      }
    }
    return urls;
  }

  has(bucket: BucketName, key: string): boolean {
    return this.objects.has(this.id(bucket, key));
  }
}
