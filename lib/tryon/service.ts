import sharp from "sharp";
import { z } from "zod";

import { aiInputHash } from "@/lib/ai/hash";
import { failureMessage } from "@/lib/ai/errors";
import { startOfDhakaDay, DAILY_SUBMISSION_LIMIT, SUBMISSION_LIMIT_MESSAGE } from "@/lib/ai/quota";
import { assertCustomer, type Actor } from "@/lib/auth/policy";
import type { PrismaClient } from "@/lib/db/client";
import { checkDesign, DesignError } from "@/lib/design/service";
import { ImageValidationError, processImage } from "@/lib/media/process-image";
import type { StorageAdapter } from "@/lib/storage/adapter";
import { BUCKETS } from "@/lib/storage/buckets";
import { buildObjectKey, isSafeObjectKey } from "@/lib/storage/object-key";
import type { DesignSpec } from "@/types/design-spec";

import { productTryOnImageKey } from "./garment";
import { tryOnPayloadSchema, tryOnResultSchema, type TryOnPayload } from "./payload";
import { consentSchema, designSignature, photoShapeProblem, productSignature, TRYON_DAILY_LIMIT, TRYON_QUOTA_MESSAGE, TRYON_RETENTION_MS } from "./rules";

// Virtual try-on, app side: consent + photo upload, queueing TRY_ON jobs, results, saving and
// deleting. The worker does the try-on (lib/ai/worker/try-on.ts). Everything is owner-scoped.

export type TryOnErrorCode = "INVALID" | "NOT_FOUND" | "CONSENT_REQUIRED" | "QUOTA" | "UPLOAD_INVALID" | "NOT_AVAILABLE";

export class TryOnError extends Error {
  override readonly name = "TryOnError";

  constructor(
    readonly code: TryOnErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const ACTIVE = ["QUEUED", "RUNNING"] as const;

/** Photos live under `{customerId}/photos/`, results under `{customerId}/results/` in tryon-private. */
export function tryOnPhotoPrefix(customerId: string): string {
  return `${customerId.toLowerCase()}/photos/`;
}

// ─── photos ──────────────────────────────────────────────────────────────────

export type TryOnPhotoView = { id: string; url: string | null; saved: boolean; createdAt: string; expiresAt: string | null };

/** Stores a customer photo for try-on. Refused without explicit consent. */
export async function uploadTryOnPhoto(
  db: PrismaClient,
  storage: StorageAdapter,
  actor: Actor,
  input: { bytes: Uint8Array; consent: unknown },
  now: Date = new Date(),
): Promise<TryOnPhotoView> {
  assertCustomer(actor);
  if (!consentSchema.safeParse(input.consent).success) {
    throw new TryOnError("CONSENT_REQUIRED", "Please agree to the try-on terms before uploading a photo.");
  }
  let image;
  try {
    image = await processImage(input.bytes, "tryOnPhoto");
  } catch (error) {
    if (error instanceof ImageValidationError) {
      throw new TryOnError("UPLOAD_INVALID", error.message);
    }
    throw error;
  }
  const { channels } = await sharp(image.data).greyscale().stats();
  const problem = photoShapeProblem({ width: image.width, height: image.height, meanBrightness: channels[0]?.mean ?? 0 });
  if (problem) {
    throw new TryOnError("UPLOAD_INVALID", problem);
  }

  const key = buildObjectKey(BUCKETS.tryonPrivate, { ownerId: actor.id, category: "photos", extension: image.extension });
  await storage.put(BUCKETS.tryonPrivate, key, image.data, image.contentType);
  try {
    const photo = await db.tryOnPhoto.create({
      data: { customerId: actor.id, storageKey: key, consentAt: now, createdAt: now },
      select: { id: true, saved: true, createdAt: true },
    });
    const urls = await storage.signReadUrls(BUCKETS.tryonPrivate, [key]);
    return toPhotoView({ ...photo, storageKey: key }, urls);
  } catch (error) {
    await storage.remove(BUCKETS.tryonPrivate, [key]).catch(() => undefined);
    throw error;
  }
}

function toPhotoView(photo: { id: string; storageKey: string; saved: boolean; createdAt: Date }, urls: Map<string, string>): TryOnPhotoView {
  return {
    id: photo.id,
    url: urls.get(photo.storageKey) ?? null,
    saved: photo.saved,
    createdAt: photo.createdAt.toISOString(),
    expiresAt: photo.saved ? null : new Date(photo.createdAt.getTime() + TRYON_RETENTION_MS).toISOString(),
  };
}

/** The customer's photos that still exist: saved ones and today's unsaved ones. Newest first. */
export async function listTryOnPhotos(db: PrismaClient, storage: StorageAdapter, actor: Actor, now: Date = new Date()): Promise<TryOnPhotoView[]> {
  const photos = await db.tryOnPhoto.findMany({
    where: {
      customerId: actor.id,
      deletedAt: null,
      OR: [{ saved: true }, { createdAt: { gt: new Date(now.getTime() - TRYON_RETENTION_MS) } }],
    },
    orderBy: { createdAt: "desc" },
    take: 12,
    select: { id: true, storageKey: true, saved: true, createdAt: true },
  });
  const urls = await storage.signReadUrls(BUCKETS.tryonPrivate, photos.map((p) => p.storageKey).filter(isSafeObjectKey));
  return photos.map((p) => toPhotoView(p, urls));
}

const idSchema = z.uuid();

async function ownPhoto(db: PrismaClient, actor: Actor, rawId: unknown) {
  const id = idSchema.safeParse(rawId);
  const photo = id.success
    ? await db.tryOnPhoto.findFirst({ where: { id: id.data, customerId: actor.id, deletedAt: null }, select: { id: true, storageKey: true } })
    : null;
  if (!photo) {
    throw new TryOnError("NOT_FOUND", "That photo doesn't exist anymore.");
  }
  return photo;
}

export async function setTryOnPhotoSaved(db: PrismaClient, actor: Actor, rawId: unknown, saved: boolean): Promise<void> {
  assertCustomer(actor);
  const photo = await ownPhoto(db, actor, rawId);
  await db.tryOnPhoto.update({ where: { id: photo.id }, data: { saved } });
}

/** Deletes a photo and every try-on made from it, right away. Audited (ids only). */
export async function deleteTryOnPhoto(db: PrismaClient, storage: StorageAdapter, actor: Actor, rawId: unknown, now: Date = new Date()): Promise<void> {
  assertCustomer(actor);
  const photo = await ownPhoto(db, actor, rawId);
  const results = await db.tryOnResult.findMany({ where: { photoId: photo.id, deletedAt: null }, select: { id: true, resultKey: true } });
  await storage.remove(BUCKETS.tryonPrivate, [photo.storageKey, ...results.map((r) => r.resultKey)]);
  await db.$transaction(async (tx) => {
    await tx.tryOnPhoto.update({ where: { id: photo.id }, data: { deletedAt: now } });
    await tx.tryOnResult.updateMany({ where: { photoId: photo.id, deletedAt: null }, data: { deletedAt: now } });
    await tx.auditLog.create({
      data: { actorId: actor.id, action: "tryon.photo_deleted", targetType: "try_on_photo", targetId: photo.id, metadata: { results: results.length } },
    });
  });
}

// ─── jobs ────────────────────────────────────────────────────────────────────

const startSchema = z.object({
  photoId: z.uuid(),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("design"), designId: z.uuid().nullish(), spec: z.unknown() }),
    z.object({ kind: z.literal("product"), productId: z.uuid() }),
  ]),
});

export type QueuedTryOn = { jobId: string; cached: boolean };

/** Try-ons made today (results plus requests still running). */
async function tryOnsToday(db: Pick<PrismaClient, "tryOnResult" | "aIJob">, customerId: string, now: Date): Promise<number> {
  const since = startOfDhakaDay(now);
  const [results, pending] = await Promise.all([
    db.tryOnResult.count({ where: { customerId, createdAt: { gte: since } } }),
    db.aIJob.count({ where: { customerId, type: "TRY_ON", status: { in: [...ACTIVE] } } }),
  ]);
  return results + pending;
}

export async function getTryOnQuota(db: PrismaClient, actor: Actor, now: Date = new Date()) {
  const used = await tryOnsToday(db, actor.id, now);
  return { used, limit: TRYON_DAILY_LIMIT, remaining: Math.max(0, TRYON_DAILY_LIMIT - used) };
}

/** Queues a try-on of a design (as it is in the editor) or a ready-made dress on one of the customer's photos. */
export async function createTryOnJob(db: PrismaClient, storage: StorageAdapter, actor: Actor, rawInput: unknown, now: Date = new Date()): Promise<QueuedTryOn> {
  assertCustomer(actor);
  const parsed = startSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new TryOnError("INVALID", "Please choose a photo and a dress to try on.");
  }
  const input = parsed.data;
  const photo = await ownPhoto(db, actor, input.photoId);

  let source: { kind: "design"; designId: string | null; spec: DesignSpec } | { kind: "product"; productId: string };
  let garmentHash: string;
  if (input.source.kind === "design") {
    let spec;
    try {
      spec = (await checkDesign(db, storage, actor.id, input.source.spec)).spec;
    } catch (error) {
      if (error instanceof DesignError) {
        throw new TryOnError("INVALID", "Fix the issues in your design before trying it on.");
      }
      throw error;
    }
    let designId: string | null = null;
    if (input.source.designId) {
      const design = await db.design.findFirst({ where: { id: input.source.designId, customerId: actor.id }, select: { id: true } });
      designId = design?.id ?? null;
    }
    source = { kind: "design", designId, spec };
    garmentHash = designSignature(spec);
  } else {
    const imageKey = await productTryOnImageKey(db, input.source.productId);
    if (!imageKey) {
      throw new TryOnError("NOT_AVAILABLE", "This dress can't be tried on right now.");
    }
    source = { kind: "product", productId: input.source.productId };
    garmentHash = productSignature(input.source.productId, imageKey);
  }

  const inputHash = aiInputHash({ v: 1, type: "TRY_ON", customerId: actor.id, photoId: photo.id, garmentHash });
  const cached = await db.tryOnResult.findFirst({ where: { customerId: actor.id, inputHash, deletedAt: null }, orderBy: { createdAt: "desc" }, select: { jobId: true } });
  if (cached) {
    return { jobId: cached.jobId, cached: true };
  }

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ai-quota:${actor.id}`}, 0))`;
    const inFlight = await tx.aIJob.findFirst({ where: { customerId: actor.id, inputHash, status: { in: [...ACTIVE] } }, select: { id: true } });
    if (inFlight) {
      return { jobId: inFlight.id, cached: true };
    }
    if ((await tryOnsToday(tx, actor.id, now)) >= TRYON_DAILY_LIMIT) {
      throw new TryOnError("QUOTA", TRYON_QUOTA_MESSAGE);
    }
    if ((await tx.aIJob.count({ where: { customerId: actor.id, createdAt: { gte: startOfDhakaDay(now) } } })) >= DAILY_SUBMISSION_LIMIT) {
      throw new TryOnError("QUOTA", SUBMISSION_LIMIT_MESSAGE);
    }
    const payload = { kind: "try_on", photoId: photo.id, source, garmentHash } satisfies TryOnPayload;
    tryOnPayloadSchema.parse(payload);
    const job = await tx.aIJob.create({
      data: { type: "TRY_ON", customerId: actor.id, payload, inputHash, runAfter: now },
      select: { id: true },
    });
    return { jobId: job.id, cached: false };
  });
}

export type TryOnResultView = {
  id: string;
  imageUrl: string | null;
  /** The photo it was made from ("before"); null once that photo is deleted. */
  photoUrl: string | null;
  photoId: string;
  photoSaved: boolean;
  saved: boolean;
  garmentHash: string;
  expiresAt: string | null;
};

export type TryOnStatus =
  | { state: "pending"; position: "queued" | "running" }
  | { state: "done"; result: TryOnResultView }
  | { state: "failed"; message: string; code: string | null };

export async function getTryOnStatus(db: PrismaClient, storage: StorageAdapter, actor: Actor, rawJobId: unknown): Promise<TryOnStatus> {
  const jobId = idSchema.safeParse(rawJobId);
  const job = jobId.success
    ? await db.aIJob.findFirst({ where: { id: jobId.data, customerId: actor.id, type: "TRY_ON" }, select: { status: true, result: true, errorCode: true } })
    : null;
  if (!job) {
    throw new TryOnError("NOT_FOUND", "That try-on doesn't exist.");
  }
  if (job.status === "QUEUED" || job.status === "RUNNING") {
    return { state: "pending", position: job.status === "QUEUED" ? "queued" : "running" };
  }
  if (job.status === "FAILED") {
    return { state: "failed", message: failureMessage(job.errorCode), code: job.errorCode };
  }
  const result = tryOnResultSchema.safeParse(job.result);
  const row = result.success
    ? await db.tryOnResult.findFirst({
        where: { id: result.data.resultId, customerId: actor.id, deletedAt: null },
        select: { id: true, resultKey: true, saved: true, garmentHash: true, createdAt: true, photo: { select: { id: true, storageKey: true, saved: true, deletedAt: true } } },
      })
    : null;
  if (!row) {
    return { state: "failed", message: "This try-on was deleted. Make a new one.", code: "DELETED" };
  }
  const photoKey = row.photo.deletedAt ? null : row.photo.storageKey;
  const urls = await storage.signReadUrls(BUCKETS.tryonPrivate, [row.resultKey, ...(photoKey ? [photoKey] : [])]);
  return {
    state: "done",
    result: {
      id: row.id,
      imageUrl: urls.get(row.resultKey) ?? null,
      photoUrl: photoKey ? (urls.get(photoKey) ?? null) : null,
      photoId: row.photo.id,
      photoSaved: row.photo.saved,
      saved: row.saved,
      garmentHash: row.garmentHash,
      expiresAt: row.saved ? null : new Date(row.createdAt.getTime() + TRYON_RETENTION_MS).toISOString(),
    },
  };
}

export async function setTryOnResultSaved(db: PrismaClient, actor: Actor, rawId: unknown, saved: boolean): Promise<void> {
  assertCustomer(actor);
  const id = idSchema.safeParse(rawId);
  const updated = id.success ? await db.tryOnResult.updateMany({ where: { id: id.data, customerId: actor.id, deletedAt: null }, data: { saved } }) : { count: 0 };
  if (updated.count !== 1) {
    throw new TryOnError("NOT_FOUND", "That try-on doesn't exist anymore.");
  }
}

// ─── 24-hour cleanup (worker sweep) ──────────────────────────────────────────

/**
 * Deletes unsaved try-on photos and results older than 24 hours: files first, then the rows are
 * marked deleted. Idempotent (only rows not yet deleted) and audited with counts only.
 */
export async function cleanupTryOnMedia(db: PrismaClient, storage: StorageAdapter, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - TRYON_RETENTION_MS);
  const [photos, results] = await Promise.all([
    db.tryOnPhoto.findMany({ where: { saved: false, deletedAt: null, createdAt: { lt: cutoff } }, select: { id: true, storageKey: true }, take: 500 }),
    db.tryOnResult.findMany({ where: { saved: false, deletedAt: null, createdAt: { lt: cutoff } }, select: { id: true, resultKey: true }, take: 500 }),
  ]);
  if (photos.length === 0 && results.length === 0) {
    return 0;
  }
  await storage.remove(BUCKETS.tryonPrivate, [...photos.map((p) => p.storageKey), ...results.map((r) => r.resultKey)]);
  await db.$transaction(async (tx) => {
    const p = await tx.tryOnPhoto.updateMany({ where: { id: { in: photos.map((x) => x.id) }, deletedAt: null }, data: { deletedAt: now } });
    const r = await tx.tryOnResult.updateMany({ where: { id: { in: results.map((x) => x.id) }, deletedAt: null }, data: { deletedAt: now } });
    await tx.auditLog.create({
      data: { actorId: null, action: "tryon.cleanup", targetType: "try_on_media", targetId: null, metadata: { photos: p.count, results: r.count, olderThan: cutoff.toISOString() } },
    });
  });
  return photos.length + results.length;
}
