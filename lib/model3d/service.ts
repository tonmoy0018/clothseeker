import { z } from "zod";

import { aiInputHash } from "@/lib/ai/hash";
import { recordLimitHit } from "@/lib/ai/limit-hits";
import { DAILY_SUBMISSION_LIMIT, startOfDhakaDay, SUBMISSION_LIMIT_MESSAGE } from "@/lib/ai/quota";
import { assertCustomer, type Actor } from "@/lib/auth/policy";
import type { PrismaClient } from "@/lib/db/client";
import { checkDesign, DesignError } from "@/lib/design/service";
import type { StorageAdapter } from "@/lib/storage/adapter";
import { BUCKETS } from "@/lib/storage/buckets";
import { isSafeObjectKey } from "@/lib/storage/object-key";
import { productTryOnImageKey } from "@/lib/tryon/garment";
import { designSignature, productSignature } from "@/lib/tryon/rules";
import type { DesignSpec } from "@/types/design-spec";

import { customerModelPrefix, garmentModelPayloadSchema, garmentModelResultSchema, MODEL3D_DAILY_LIMIT, MODEL3D_QUOTA_MESSAGE, type GarmentModelPayload } from "./payload";

// The 3D view, app side: queueing GARMENT_MODEL jobs for a design (as it is in the editor) or a
// ready-made item, and reading their result. The worker builds the model (lib/ai/worker/garment-model.ts).
// Everything is owner-scoped; models are kept (they show a garment, not the customer).

export type Model3dErrorCode = "INVALID" | "NOT_FOUND" | "QUOTA" | "NOT_AVAILABLE";

export class Model3dError extends Error {
  override readonly name = "Model3dError";

  constructor(
    readonly code: Model3dErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const ACTIVE = ["QUEUED", "RUNNING"] as const;

const startSchema = z.object({
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("design"), designId: z.uuid().nullish(), spec: z.unknown() }),
    z.object({ kind: z.literal("product"), productId: z.uuid() }),
  ]),
});

export type QueuedModel = { jobId: string; cached: boolean };

/** 3D views asked for today that didn't fail (made, or still being made). */
function modelsToday(db: Pick<PrismaClient, "aIJob">, customerId: string, now: Date): Promise<number> {
  return db.aIJob.count({ where: { customerId, type: "GARMENT_MODEL", createdAt: { gte: startOfDhakaDay(now) }, status: { not: "FAILED" } } });
}

/** Queues a 3D model of a design or a ready-made item, or hands back the one already made for it. */
export async function createGarmentModelJob(db: PrismaClient, storage: StorageAdapter, actor: Actor, rawInput: unknown, now: Date = new Date()): Promise<QueuedModel> {
  assertCustomer(actor);
  const parsed = startSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new Model3dError("INVALID", "Please choose a garment to see in 3D.");
  }
  const input = parsed.data;

  let source: { kind: "design"; designId: string | null; spec: DesignSpec } | { kind: "product"; productId: string };
  let garmentHash: string;
  if (input.source.kind === "design") {
    let spec;
    try {
      spec = (await checkDesign(db, storage, actor.id, input.source.spec)).spec;
    } catch (error) {
      if (error instanceof DesignError) {
        throw new Model3dError("INVALID", "Fix the issues in your design before seeing it in 3D.");
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
      throw new Model3dError("NOT_AVAILABLE", "This garment can't be shown in 3D right now.");
    }
    source = { kind: "product", productId: input.source.productId };
    garmentHash = productSignature(input.source.productId, imageKey);
  }

  const inputHash = aiInputHash({ v: 1, type: "GARMENT_MODEL", customerId: actor.id, garmentHash });
  // Made before: no new job, no quota (models are never deleted).
  const made = await db.aIJob.findFirst({ where: { customerId: actor.id, type: "GARMENT_MODEL", inputHash, status: "SUCCEEDED" }, orderBy: { createdAt: "desc" }, select: { id: true, result: true } });
  if (made && garmentModelResultSchema.safeParse(made.result).success) {
    return { jobId: made.id, cached: true };
  }

  try {
    return await queue();
  } catch (error) {
    if (error instanceof Model3dError && error.code === "QUOTA") {
      await recordLimitHit(db, actor.id, error.message === MODEL3D_QUOTA_MESSAGE ? "GARMENT_MODEL" : "SUBMISSIONS");
    }
    throw error;
  }

  function queue(): Promise<QueuedModel> {
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ai-quota:${actor.id}`}, 0))`;
      const inFlight = await tx.aIJob.findFirst({ where: { customerId: actor.id, inputHash, status: { in: [...ACTIVE] } }, select: { id: true } });
      if (inFlight) {
        return { jobId: inFlight.id, cached: true };
      }
      if ((await modelsToday(tx, actor.id, now)) >= MODEL3D_DAILY_LIMIT) {
        throw new Model3dError("QUOTA", MODEL3D_QUOTA_MESSAGE);
      }
      if ((await tx.aIJob.count({ where: { customerId: actor.id, createdAt: { gte: startOfDhakaDay(now) } } })) >= DAILY_SUBMISSION_LIMIT) {
        throw new Model3dError("QUOTA", SUBMISSION_LIMIT_MESSAGE);
      }
      const payload = { kind: "garment_model", source, garmentHash } satisfies GarmentModelPayload;
      garmentModelPayloadSchema.parse(payload);
      const job = await tx.aIJob.create({ data: { type: "GARMENT_MODEL", customerId: actor.id, payload, inputHash, runAfter: now }, select: { id: true } });
      return { jobId: job.id, cached: false };
    });
  }
}

/** What the customer is told when a model couldn't be made (the job's error code is internal). */
function failureText(code: string | null): string {
  return code === "NOT_AVAILABLE" ? "This garment can't be shown in 3D right now." : "The 3D view couldn't be made this time. Please try again in a minute.";
}

export type GarmentModelStatus =
  | { state: "pending"; position: "queued" | "running" }
  | { state: "done"; modelUrl: string }
  | { state: "failed"; message: string };

export async function getGarmentModelStatus(db: PrismaClient, storage: StorageAdapter, actor: Actor, rawJobId: unknown): Promise<GarmentModelStatus> {
  const jobId = z.uuid().safeParse(rawJobId);
  const job = jobId.success ? await db.aIJob.findFirst({ where: { id: jobId.data, customerId: actor.id, type: "GARMENT_MODEL" }, select: { status: true, result: true, errorCode: true } }) : null;
  if (!job) {
    throw new Model3dError("NOT_FOUND", "That 3D view doesn't exist.");
  }
  if (job.status === "QUEUED" || job.status === "RUNNING") {
    return { state: "pending", position: job.status === "QUEUED" ? "queued" : "running" };
  }
  if (job.status === "FAILED") {
    return { state: "failed", message: failureText(job.errorCode) };
  }
  const key = garmentModelResultSchema.safeParse(job.result).data?.modelKey;
  // Only the customer's own models are signed.
  const url = key && isSafeObjectKey(key) && key.startsWith(customerModelPrefix(actor.id)) ? (await storage.signReadUrls(BUCKETS.designAssets, [key])).get(key) : undefined;
  return url ? { state: "done", modelUrl: url } : { state: "failed", message: failureText(null) };
}
