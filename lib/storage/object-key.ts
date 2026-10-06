import { z } from "zod";

import { BUCKET_EXTENSIONS, type BucketName } from "./buckets";

// Object keys are always generated on the server. User-supplied filenames never become
// part of a key, which rules out path traversal and collisions by construction.

const SEGMENT = /^[a-z0-9][a-z0-9-]{0,62}$/;
const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}(\/[a-z0-9][a-z0-9-]{0,62}){1,4}\.[a-z0-9]{2,5}$/;

const keyInputSchema = z.object({
  /** Owning scope, e.g. a user id or product id. */
  ownerId: z.uuid(),
  /** Logical folder, e.g. "products", "qc", "renders". */
  category: z.string().regex(SEGMENT),
  extension: z
    .string()
    .transform((ext) => ext.toLowerCase().replace(/^\./, ""))
    .pipe(z.string().regex(/^[a-z0-9]{2,5}$/)),
});

export type ObjectKeyInput = z.input<typeof keyInputSchema>;

export class InvalidObjectKeyError extends Error {
  override readonly name = "InvalidObjectKeyError";
}

export function buildObjectKey(
  bucket: BucketName,
  input: ObjectKeyInput,
  generateId: () => string = () => crypto.randomUUID(),
): string {
  const parsed = keyInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidObjectKeyError("Invalid object key input");
  }
  const { ownerId, category, extension } = parsed.data;
  if (!BUCKET_EXTENSIONS[bucket].includes(extension)) {
    throw new InvalidObjectKeyError(`Extension not allowed for bucket ${bucket}`);
  }
  const key = `${ownerId.toLowerCase()}/${category}/${generateId().toLowerCase()}.${extension}`;
  assertSafeObjectKey(key);
  return key;
}

/** Use before signing or deleting a key read back from the database. */
export function assertSafeObjectKey(key: string): void {
  if (key.includes("..") || !KEY_PATTERN.test(key)) {
    throw new InvalidObjectKeyError("Unsafe object key");
  }
}

export function isSafeObjectKey(key: string): boolean {
  return !key.includes("..") && KEY_PATTERN.test(key);
}
