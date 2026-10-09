import { z } from "zod";

import { assertCustomer, type Actor } from "@/lib/auth/policy";
import type { PrismaClient } from "@/lib/db/client";
import { customerReferencePrefix } from "@/lib/design/validate";
import { ImageValidationError, processImage } from "@/lib/media/process-image";
import type { StorageAdapter } from "@/lib/storage/adapter";
import { BUCKETS } from "@/lib/storage/buckets";
import { buildObjectKey, isSafeObjectKey } from "@/lib/storage/object-key";

import { findBrandTerm } from "./brands";
import { AiError, BRAND_LOGO_MESSAGE, failureMessage } from "./errors";
import { aiInputHash, normalizeInstruction } from "./hash";
import { DAILY_ROUND_LIMIT, DAILY_SUBMISSION_LIMIT, QUOTA_MESSAGE, startOfDhakaDay, SUBMISSION_LIMIT_MESSAGE } from "./quota";

// "Start a design from a dress photo or a description" (app side). Queues a DRESS_MATCH job; the
// worker picks the closest customizable dress, prefills a draft design (lib/ai/worker/dress-match.ts)
// and, for descriptions, queues an AI design round on it.

const key = z.string().max(200).refine(isSafeObjectKey);

export const dressMatchPayloadSchema = z.object({
  kind: z.literal("dress_match"),
  mode: z.enum(["photo", "description"]),
  referenceKey: key.nullable(),
  description: z.string().min(10).max(500).nullable(),
  seed: z.string().length(64),
});
export type DressMatchPayload = z.infer<typeof dressMatchPayloadSchema>;

export const dressMatchResultSchema = z.object({
  designId: z.uuid(),
  productId: z.uuid(),
  alternatives: z.array(z.uuid()).max(2),
  /** The AI design round queued for a description start (null if today's rounds were used up). */
  roundJobId: z.uuid().nullable(),
});
export type DressMatchResult = z.infer<typeof dressMatchResultSchema>;

const ACTIVE = ["QUEUED", "RUNNING"] as const;

/** Stores the customer's dress photo (re-encoded, metadata stripped) under `references/`. */
export async function uploadReferencePhoto(storage: StorageAdapter, actor: Actor, bytes: Uint8Array): Promise<{ key: string; url: string | null }> {
  assertCustomer(actor);
  let image;
  try {
    image = await processImage(bytes, "aiInput");
  } catch (error) {
    if (error instanceof ImageValidationError) {
      throw new AiError("UPLOAD_INVALID", error.message);
    }
    throw error;
  }
  const objectKey = buildObjectKey(BUCKETS.designAssets, { ownerId: actor.id, category: "references", extension: image.extension });
  await storage.put(BUCKETS.designAssets, objectKey, image.data, image.contentType);
  const urls = await storage.signReadUrls(BUCKETS.designAssets, [objectKey]);
  return { key: objectKey, url: urls.get(objectKey) ?? null };
}

const startSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("photo"), referenceKey: z.string().max(200) }),
  z.object({
    mode: z.literal("description"),
    description: z.string().trim().min(10, "Describe the dress in a sentence or two.").max(500, "Keep your description under 500 characters."),
  }),
]);

/** Queues a dress match. Identical requests get the earlier job back. */
export async function startDesignFrom(
  db: PrismaClient,
  storage: StorageAdapter,
  actor: Actor,
  rawInput: unknown,
  now: Date = new Date(),
): Promise<{ jobId: string; cached: boolean }> {
  assertCustomer(actor);
  const parsed = startSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AiError("INVALID", parsed.error.issues[0]?.message ?? "Please check your request.");
  }
  const input = parsed.data;
  let referenceKey: string | null = null;
  let description: string | null = null;
  if (input.mode === "photo") {
    if (!isSafeObjectKey(input.referenceKey) || !input.referenceKey.startsWith(customerReferencePrefix(actor.id))) {
      throw new AiError("INVALID", "That photo isn't yours.");
    }
    if ((await storage.signReadUrls(BUCKETS.designAssets, [input.referenceKey], 60)).size !== 1) {
      throw new AiError("INVALID", "The photo is missing. Please upload it again.");
    }
    referenceKey = input.referenceKey;
  } else {
    if (findBrandTerm(input.description)) {
      throw new AiError("BRAND_LOGO", BRAND_LOGO_MESSAGE);
    }
    description = input.description.replace(/\s+/g, " ");
  }

  const inputHash = aiInputHash({ v: 1, type: "DRESS_MATCH", customerId: actor.id, referenceKey, description: description ? normalizeInstruction(description) : null });
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ai-quota:${actor.id}`}, 0))`;
    const earlier = await tx.aIJob.findFirst({
      where: { customerId: actor.id, type: "DRESS_MATCH", inputHash, status: { in: [...ACTIVE, "SUCCEEDED"] } },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, result: true },
    });
    const earlierResult = dressMatchResultSchema.safeParse(earlier?.result);
    const designStillThere = earlierResult.success ? (await tx.design.count({ where: { id: earlierResult.data.designId, customerId: actor.id } })) === 1 : false;
    if (earlier && (earlier.status !== "SUCCEEDED" || designStillThere)) {
      return { jobId: earlier.id, cached: true };
    }

    const since = startOfDhakaDay(now);
    if ((await tx.aIJob.count({ where: { customerId: actor.id, createdAt: { gte: since } } })) >= DAILY_SUBMISSION_LIMIT) {
      throw new AiError("QUOTA", SUBMISSION_LIMIT_MESSAGE);
    }
    if (input.mode === "description") {
      // A description start runs one AI design round, so it needs one left today.
      const [rounds, pending] = await Promise.all([
        tx.aIRound.count({ where: { customerId: actor.id, createdAt: { gte: since } } }),
        tx.aIJob.count({ where: { customerId: actor.id, type: "DESIGN_ROUND", status: { in: [...ACTIVE] } } }),
      ]);
      if (rounds + pending >= DAILY_ROUND_LIMIT) {
        throw new AiError("QUOTA", QUOTA_MESSAGE);
      }
    }
    const payload = { kind: "dress_match", mode: input.mode, referenceKey, description, seed: inputHash } satisfies DressMatchPayload;
    const job = await tx.aIJob.create({ data: { type: "DRESS_MATCH", customerId: actor.id, payload, inputHash, runAfter: now }, select: { id: true } });
    return { jobId: job.id, cached: false };
  });
}

export type StartStatus =
  | { state: "pending"; position: "queued" | "running" }
  | { state: "done"; result: DressMatchResult }
  | { state: "failed"; message: string; code: string | null };

export async function getStartStatus(db: PrismaClient, actor: Actor, rawJobId: unknown): Promise<StartStatus> {
  const jobId = z.uuid().safeParse(rawJobId);
  const job = jobId.success
    ? await db.aIJob.findFirst({ where: { id: jobId.data, customerId: actor.id, type: "DRESS_MATCH" }, select: { status: true, result: true, errorCode: true } })
    : null;
  if (!job) {
    throw new AiError("NOT_FOUND", "That request doesn't exist.");
  }
  if (job.status === "QUEUED" || job.status === "RUNNING") {
    return { state: "pending", position: job.status === "QUEUED" ? "queued" : "running" };
  }
  if (job.status === "FAILED") {
    return { state: "failed", message: failureMessage(job.errorCode), code: job.errorCode };
  }
  const result = dressMatchResultSchema.safeParse(job.result);
  return result.success ? { state: "done", result: result.data } : { state: "failed", message: failureMessage("INTERNAL"), code: "INTERNAL" };
}
