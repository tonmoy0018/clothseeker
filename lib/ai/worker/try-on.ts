import { randomUUID } from "node:crypto";

import { garmentPicture } from "@/lib/design/garment-variant";
import { normalizeForRender } from "@/lib/design/normalize";
import { checkDesign, DesignError } from "@/lib/design/service";
import { ImageValidationError, processImage } from "@/lib/media/process-image";
import { renderFlatGarment, storageAssets } from "@/lib/renderer/render";
import { BUCKETS } from "@/lib/storage/buckets";
import { buildObjectKey } from "@/lib/storage/object-key";
import { productTryOnImageKey } from "@/lib/tryon/garment";
import { tryOnPayloadSchema, type TryOnPayload } from "@/lib/tryon/payload";
import { designSignature, productSignature } from "@/lib/tryon/rules";

import { AiJobRejected, AiProviderError, type AiFailureCode } from "../errors";
import { prepareGarment } from "../image-utils";
import type { TryOnPhotoCheck } from "../types";

import { leaseWhere, LostLease, type ClaimedJob } from "./claim";
import type { AiWorkerDeps } from "./run";

// One virtual try-on, run by the worker:
//   photo check (once per photo) → flat garment on a white 3:4 canvas → TryOnProvider
//   → re-encode → one transaction: TryOnResult + job SUCCEEDED (only while holding the lease).

const GARMENT_RENDER_WIDTH = 900;

/** The first check a photo failed, so the customer is told exactly what to change. */
export function photoProblem(check: TryOnPhotoCheck): AiFailureCode {
  if (!check.onePerson) return "PHOTO_NOT_ONE_PERSON";
  if (!check.facingForward) return "PHOTO_NOT_FACING";
  if (!check.goodLight) return "PHOTO_TOO_DARK";
  if (!check.bodyVisible) return "PHOTO_BODY_NOT_VISIBLE";
  return "PHOTO_REJECTED";
}

async function garmentImage(deps: AiWorkerDeps, job: ClaimedJob, source: TryOnPayload["source"], expectedHash: string): Promise<Buffer> {
  const { db, storage } = deps;
  if (source.kind === "design") {
    let checked;
    try {
      checked = await checkDesign(db, storage, job.customerId, source.spec);
    } catch (error) {
      if (error instanceof DesignError) {
        throw new AiJobRejected("NOT_AVAILABLE");
      }
      throw error;
    }
    if (designSignature(checked.spec) !== expectedHash) {
      throw new AiJobRejected("INTERNAL");
    }
    const config = checked.context.template.config;
    const picture = garmentPicture(config, "front", checked.spec.styleOptions);
    const maskKeys = config.regions.flatMap((r) => picture.maskFor(r.id) ?? []);
    const flat = await renderFlatGarment(normalizeForRender(checked.spec, config), storageAssets(storage), maskKeys, GARMENT_RENDER_WIDTH);
    return prepareGarment(flat);
  }
  const imageKey = await productTryOnImageKey(db, source.productId);
  if (!imageKey || productSignature(source.productId, imageKey) !== expectedHash) {
    throw new AiJobRejected("NOT_AVAILABLE");
  }
  const image = await storage.get(BUCKETS.productMedia, imageKey);
  if (!image) {
    throw new AiJobRejected("NOT_AVAILABLE");
  }
  return prepareGarment(image);
}

export async function runTryOn(deps: AiWorkerDeps, job: ClaimedJob, signal: AbortSignal): Promise<void> {
  const { db, storage, providers } = deps;
  const parsed = tryOnPayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    throw new AiJobRejected("INTERNAL");
  }
  const input = parsed.data;

  const photo = await db.tryOnPhoto.findFirst({
    where: { id: input.photoId, customerId: job.customerId, deletedAt: null },
    select: { id: true, storageKey: true, checkedAt: true },
  });
  const photoBytes = photo ? await storage.get(BUCKETS.tryonPrivate, photo.storageKey) : null;
  if (!photo || !photoBytes) {
    // Deleted (by the customer or the 24-hour cleanup) while the job waited.
    throw new AiJobRejected("NOT_AVAILABLE");
  }
  const person = { data: photoBytes, mimeType: "image/webp" as const };

  // 1. Photo check, once per photo: one person, facing forward, good light, body visible.
  if (!photo.checkedAt) {
    const check = await providers.planner.checkTryOnPhoto(person, signal);
    if (!check.onePerson || !check.facingForward || !check.goodLight || !check.bodyVisible) {
      deps.log?.("ai.tryon_photo_rejected", {
        jobId: job.id,
        onePerson: check.onePerson,
        facingForward: check.facingForward,
        goodLight: check.goodLight,
        bodyVisible: check.bodyVisible,
      });
      throw new AiJobRejected(photoProblem(check));
    }
    await db.tryOnPhoto.update({ where: { id: photo.id }, data: { checkedAt: (deps.now ?? (() => new Date()))() } });
  }

  // 2. The garment as try-on models expect it.
  const garment = await garmentImage(deps, job, input.source, input.garmentHash);
  if (signal.aborted) {
    throw new AiProviderError("job aborted", true, "TIMEOUT");
  }

  // 3. Try-on, then treat the returned bytes like any upload.
  const raw = await providers.tryOn.tryOn({ person, garment: { data: garment, mimeType: "image/png" } }, signal);
  let image;
  try {
    image = await processImage(raw, "tryOnResult");
  } catch (error) {
    if (error instanceof ImageValidationError) {
      throw new AiProviderError("try-on provider returned an unusable image", true);
    }
    throw error;
  }
  if (signal.aborted) {
    throw new AiProviderError("job aborted", true, "TIMEOUT");
  }

  const resultKey = buildObjectKey(BUCKETS.tryonPrivate, { ownerId: job.customerId, category: "results", extension: image.extension });
  await storage.put(BUCKETS.tryonPrivate, resultKey, image.data, image.contentType);
  try {
    const resultId = randomUUID();
    const now = (deps.now ?? (() => new Date()))();
    await db.$transaction(async (tx) => {
      await tx.tryOnResult.create({
        data: {
          id: resultId,
          customerId: job.customerId,
          photoId: photo.id,
          designId: input.source.kind === "design" ? input.source.designId : null,
          productId: input.source.kind === "product" ? input.source.productId : null,
          garmentHash: input.garmentHash,
          inputHash: job.inputHash,
          resultKey,
          jobId: job.id,
        },
      });
      const finished = await tx.aIJob.updateMany({
        where: leaseWhere(job, deps.workerId),
        data: { status: "SUCCEEDED", result: { resultId }, finishedAt: now, lockedAt: null, lockedBy: null, error: null, errorCode: null },
      });
      if (finished.count !== 1) {
        throw new LostLease();
      }
    });
    deps.log?.("ai.tryon_saved", { jobId: job.id, resultId, provider: providers.tryOn.name });
  } catch (error) {
    await storage.remove(BUCKETS.tryonPrivate, [resultKey]).catch(() => undefined);
    throw error;
  }
}
