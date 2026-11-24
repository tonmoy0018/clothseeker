import { z } from "zod";

import { recordLimitHit } from "@/lib/ai/limit-hits";
import { startOfDhakaDay } from "@/lib/ai/quota";
import { assertCustomer, type Actor } from "@/lib/auth/policy";
import type { PrismaClient } from "@/lib/db/client";
import type { StorageAdapter } from "@/lib/storage/adapter";
import { BUCKETS } from "@/lib/storage/buckets";
import { assertSafeObjectKey, buildObjectKey } from "@/lib/storage/object-key";
import { parseTemplateConfig } from "@/types/template";

import { cutOutDecoration, CutoutError } from "./extract";
import { CUTOUT_DAILY_LIMIT, CUTOUT_LIMIT_MESSAGE, cutoutInputSchema, cutoutSettingsSchema, type CutoutSettings } from "./rules";

// Taking a decoration from another ClothSeeker dress: the customer boxes it on a product photo and the
// server cuts it out (lib/cutouts/extract.ts). Only live ClothSeeker products, only the customer's own
// cut-outs, 30 a day. The file goes to design-assets `{customerId}/cutouts/` and is used as an image layer.

export type CutoutErrorCode = "INVALID" | "NOT_FOUND" | "LIMIT" | "TOO_SMALL" | "EMPTY";

export class CutoutServiceError extends Error {
  override readonly name = "CutoutServiceError";

  constructor(
    readonly code: CutoutErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type CutoutView = {
  id: string;
  key: string;
  url: string | null;
  productName: string;
  width: number;
  height: number;
  palette: string[];
  settings: CutoutSettings | null;
  /** The source dress, when it's still in the shop (to cut again with other settings). */
  productId: string | null;
  imageIndex: number;
};

async function cutoutsToday(db: Pick<PrismaClient, "decorationCutout">, customerId: string, now: Date): Promise<number> {
  return db.decorationCutout.count({ where: { customerId, createdAt: { gte: startOfDhakaDay(now) } } });
}

/** Cuts a decoration out of a product photo for the customer. Returns it with a signed URL. */
export async function createCutout(db: PrismaClient, storage: StorageAdapter, actor: Actor, rawInput: unknown, now = new Date()): Promise<CutoutView> {
  assertCustomer(actor);
  const parsed = cutoutInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new CutoutServiceError("INVALID", "Draw a box around the decoration on the photo.");
  }
  const input = parsed.data;

  const product = await db.product.findFirst({ where: { id: input.productId, status: "ACTIVE" }, select: { id: true, name: true, imageKeys: true } });
  const photoKey = product?.imageKeys[input.imageIndex];
  if (!product || !photoKey) {
    throw new CutoutServiceError("NOT_FOUND", "That photo isn't available any more.");
  }
  if (input.swaps.some((s) => s !== null)) {
    const template = await db.customizationTemplate.findFirst({ where: { productId: input.designProductId, isActive: true }, select: { config: true } });
    const allowed = new Set(template ? parseTemplateConfig(template.config).allowedColors.map((c) => c.hex.toLowerCase()) : []);
    if (input.swaps.some((s) => s !== null && !allowed.has(s))) {
      throw new CutoutServiceError("INVALID", "Pick the new colours from this design's colours.");
    }
  }
  // A quick check before the work; the real one is under the lock below.
  if ((await cutoutsToday(db, actor.id, now)) >= CUTOUT_DAILY_LIMIT) {
    await recordLimitHit(db, actor.id, "CUTOUT");
    throw new CutoutServiceError("LIMIT", CUTOUT_LIMIT_MESSAGE);
  }

  const photo = await storage.get(BUCKETS.productMedia, photoKey);
  if (!photo) {
    throw new CutoutServiceError("NOT_FOUND", "That photo isn't available any more.");
  }
  let cut;
  try {
    cut = await cutOutDecoration(photo, input.box, input.strength, input.swaps);
  } catch (error) {
    if (error instanceof CutoutError) throw new CutoutServiceError(error.code, error.message);
    throw error;
  }

  const key = buildObjectKey(BUCKETS.designAssets, { ownerId: actor.id, category: "cutouts", extension: "webp" });
  await storage.put(BUCKETS.designAssets, key, cut.data, "image/webp");
  const settings: CutoutSettings = { box: input.box, strength: input.strength, swaps: input.swaps };
  let row;
  try {
    row = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`cutouts:${actor.id}`}, 0))`;
      if ((await cutoutsToday(tx, actor.id, now)) >= CUTOUT_DAILY_LIMIT) {
        throw new CutoutServiceError("LIMIT", CUTOUT_LIMIT_MESSAGE);
      }
      return tx.decorationCutout.create({
        data: {
          customerId: actor.id,
          productId: product.id,
          productName: product.name,
          imageIndex: input.imageIndex,
          settings,
          imageKey: key,
          width: cut.width,
          height: cut.height,
          palette: cut.palette,
          createdAt: now,
        },
      });
    });
  } catch (error) {
    await storage.remove(BUCKETS.designAssets, [key]).catch(() => undefined);
    if (error instanceof CutoutServiceError && error.code === "LIMIT") await recordLimitHit(db, actor.id, "CUTOUT");
    throw error;
  }
  const urls = await storage.signReadUrls(BUCKETS.designAssets, [key]);
  return {
    id: row.id,
    key,
    url: urls.get(key) ?? null,
    productName: row.productName,
    width: row.width,
    height: row.height,
    palette: row.palette,
    settings,
    productId: row.productId,
    imageIndex: row.imageIndex,
  };
}

/** The customer's own cut-outs, newest first, with signed URLs. */
export async function listCutouts(db: PrismaClient, storage: StorageAdapter, actor: Actor, limit = 24): Promise<{ cutouts: CutoutView[]; left: number }> {
  assertCustomer(actor);
  const [rows, used] = await Promise.all([
    db.decorationCutout.findMany({ where: { customerId: actor.id }, orderBy: { createdAt: "desc" }, take: limit }),
    cutoutsToday(db, actor.id, new Date()),
  ]);
  const keys = rows.map((r) => r.imageKey);
  keys.forEach(assertSafeObjectKey);
  const urls = keys.length > 0 ? await storage.signReadUrls(BUCKETS.designAssets, keys) : new Map<string, string>();
  return {
    cutouts: rows.map((r) => {
      const settings = cutoutSettingsSchema.safeParse(r.settings);
      return {
        id: r.id,
        key: r.imageKey,
        url: urls.get(r.imageKey) ?? null,
        productName: r.productName,
        width: r.width,
        height: r.height,
        palette: r.palette,
        settings: settings.success ? settings.data : null,
        productId: r.productId,
        imageIndex: r.imageIndex,
      };
    }),
    left: Math.max(0, CUTOUT_DAILY_LIMIT - used),
  };
}

export type CutoutSource = { productId: string; name: string; photos: { index: number; url: string }[] };

/** ClothSeeker dresses a decoration can be taken from: live products with photos (up to 4 photos each). */
export async function listCutoutSources(db: PrismaClient, storage: StorageAdapter, actor: Actor): Promise<CutoutSource[]> {
  assertCustomer(actor);
  const products = await db.product.findMany({
    where: { status: "ACTIVE", NOT: { imageKeys: { isEmpty: true } } },
    orderBy: [{ createdAt: "asc" }, { name: "asc" }],
    take: 60,
    select: { id: true, name: true, imageKeys: true },
  });
  const keys = products.flatMap((p) => p.imageKeys.slice(0, 4));
  const urls = keys.length > 0 ? await storage.signReadUrls(BUCKETS.productMedia, keys) : new Map<string, string>();
  return products
    .map((p) => ({
      productId: p.id,
      name: p.name,
      photos: p.imageKeys.slice(0, 4).flatMap((key, index) => {
        const url = urls.get(key);
        return url ? [{ index, url }] : [];
      }),
    }))
    .filter((p) => p.photos.length > 0);
}

/** Cut-out records for image keys in a design (the production sheet names their source dress). */
export async function cutoutsByKey(db: PrismaClient, keys: readonly string[]): Promise<Map<string, { productName: string; width: number; height: number }>> {
  const valid = keys.filter((k) => z.string().max(200).safeParse(k).success);
  if (valid.length === 0) return new Map();
  const rows = await db.decorationCutout.findMany({ where: { imageKey: { in: [...valid] } }, select: { imageKey: true, productName: true, width: true, height: true } });
  return new Map(rows.map((r) => [r.imageKey, r]));
}
