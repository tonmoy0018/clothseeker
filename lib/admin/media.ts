import { z } from "zod";

import { assertAdmin, type Actor } from "@/lib/auth/policy";
import type { PrismaClient } from "@/lib/db/client";
import { ImageValidationError, processImage, type ImagePurpose } from "@/lib/media/process-image";
import type { StorageAdapter } from "@/lib/storage/adapter";
import { BUCKETS } from "@/lib/storage/buckets";
import { buildObjectKey } from "@/lib/storage/object-key";

import { writeAudit } from "./audit";
import { AdminError } from "./errors";

export const MAX_PRODUCT_PHOTOS = 8;

const productIdSchema = z.uuid();
const photoRefSchema = z.object({ productId: z.uuid(), key: z.string().min(1).max(200) });

/** Validates, normalizes and stores an image under the product's own prefix. Returns the new key. */
export async function storeProductImage(
  storage: StorageAdapter,
  productId: string,
  bytes: Uint8Array,
  purpose: ImagePurpose,
  category: "photos" | "template" | "style",
): Promise<string> {
  let image;
  try {
    image = await processImage(bytes, purpose);
  } catch (error) {
    if (error instanceof ImageValidationError) {
      throw new AdminError("INVALID", error.message);
    }
    throw error;
  }
  const key = buildObjectKey(BUCKETS.productMedia, { ownerId: productId, category, extension: image.extension });
  await storage.put(BUCKETS.productMedia, key, image.data, image.contentType);
  return key;
}

export async function uploadProductPhoto(
  db: PrismaClient,
  storage: StorageAdapter,
  actor: Actor,
  rawProductId: unknown,
  bytes: Uint8Array,
): Promise<{ key: string }> {
  assertAdmin(actor);
  const productId = productIdSchema.parse(rawProductId);
  const product = await db.product.findUnique({ where: { id: productId }, select: { imageKeys: true } });
  if (!product) {
    throw new AdminError("NOT_FOUND", "That dress no longer exists.");
  }
  if (product.imageKeys.length >= MAX_PRODUCT_PHOTOS) {
    throw new AdminError("LIMIT", `A dress can have at most ${MAX_PRODUCT_PHOTOS} photos. Remove one first.`);
  }

  const key = await storeProductImage(storage, productId, bytes, "productPhoto", "photos");
  try {
    await db.$transaction(async (tx) => {
      // Atomic append, so concurrent uploads can't overwrite each other's keys.
      await tx.product.update({ where: { id: productId }, data: { imageKeys: { push: key } } });
      await writeAudit(tx, actor, "product.photo.add", { type: "product", id: productId }, { key });
    });
  } catch (error) {
    await storage.remove(BUCKETS.productMedia, [key]).catch(() => undefined);
    throw error;
  }
  return { key };
}

export async function removeProductPhoto(
  db: PrismaClient,
  storage: StorageAdapter,
  actor: Actor,
  rawInput: unknown,
): Promise<void> {
  assertAdmin(actor);
  const input = photoRefSchema.parse(rawInput);
  const product = await db.product.findUnique({ where: { id: input.productId }, select: { imageKeys: true } });
  // Only keys that belong to this product can be removed — never an arbitrary object.
  if (!product || !product.imageKeys.includes(input.key)) {
    throw new AdminError("NOT_FOUND", "That photo is no longer attached to this dress.");
  }
  await db.$transaction(async (tx) => {
    await tx.product.update({
      where: { id: input.productId },
      data: { imageKeys: product.imageKeys.filter((k) => k !== input.key) },
    });
    await writeAudit(tx, actor, "product.photo.remove", { type: "product", id: input.productId }, { key: input.key });
  });
  await storage.remove(BUCKETS.productMedia, [input.key]);
}

/** Moves a photo to the front; the first photo is the cover in the shop. */
export async function setCoverPhoto(db: PrismaClient, actor: Actor, rawInput: unknown): Promise<void> {
  assertAdmin(actor);
  const input = photoRefSchema.parse(rawInput);
  const product = await db.product.findUnique({ where: { id: input.productId }, select: { imageKeys: true } });
  if (!product || !product.imageKeys.includes(input.key)) {
    throw new AdminError("NOT_FOUND", "That photo is no longer attached to this dress.");
  }
  if (product.imageKeys[0] === input.key) {
    return;
  }
  await db.$transaction(async (tx) => {
    await tx.product.update({
      where: { id: input.productId },
      data: { imageKeys: [input.key, ...product.imageKeys.filter((k) => k !== input.key)] },
    });
    await writeAudit(tx, actor, "product.photo.cover", { type: "product", id: input.productId }, { key: input.key });
  });
}
