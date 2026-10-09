import { z } from "zod";

import { assertCustomer, type Actor } from "@/lib/auth/policy";
import type { PrismaClient } from "@/lib/db/client";
import { checkDesign, DesignError, type CheckedDesign } from "@/lib/design/service";
import type { DesignPrice } from "@/lib/design/pricing";
import { ImageValidationError, processImage } from "@/lib/media/process-image";
import type { StorageAdapter } from "@/lib/storage/adapter";
import { BUCKETS } from "@/lib/storage/buckets";
import { buildObjectKey, isSafeObjectKey } from "@/lib/storage/object-key";
import type { DesignSpec } from "@/types/design-spec";

import { findBrandTerm } from "./brands";
import { AiError, BRAND_LOGO_MESSAGE, failureMessage } from "./errors";
import { aiInputHash, normalizeInstruction } from "./hash";
import { DAILY_ROUND_LIMIT, DAILY_SUBMISSION_LIMIT, QUOTA_MESSAGE, quotaFrom, startOfDhakaDay, SUBMISSION_LIMIT_MESSAGE, type AiQuota } from "./quota";
import { designRoundPayloadSchema, designRoundResultSchema, referenceSchema, storedOptionsSchema, type DesignRoundPayload } from "./rounds";

// The app side of the AI design box: validate a request, enforce the daily quota, reuse cached
// results, and queue a job for the worker. The app never calls an AI provider itself.

export const MAX_AI_ATTACHMENTS = 3;

/** Customer photos for AI requests live under `{customerId}/ai-inputs/` in design-assets. */
export function aiInputPrefix(customerId: string): string {
  return `${customerId.toLowerCase()}/ai-inputs/`;
}

const requestSchema = z.object({
  designId: z.uuid().nullish(),
  spec: z.unknown(),
  instruction: z
    .string()
    .trim()
    .min(3, "Describe what you'd like in a few words.")
    .max(500, "Keep your description under 500 characters."),
  attachmentKeys: z.array(z.string().max(200)).max(MAX_AI_ATTACHMENTS, `Attach up to ${MAX_AI_ATTACHMENTS} photos.`).default([]),
  reference: referenceSchema.nullish(),
  /** "Generate again": same request, fresh results. */
  again: z.boolean().default(false),
});

export type DesignRoundRequest = z.input<typeof requestSchema>;
export type QueuedRound = { jobId: string; designId: string; cached: boolean };

const ACTIVE = ["QUEUED", "RUNNING"] as const;

async function checkAiDesign(db: PrismaClient, storage: StorageAdapter, customerId: string, rawSpec: unknown): Promise<CheckedDesign> {
  let checked: CheckedDesign;
  try {
    checked = await checkDesign(db, storage, customerId, rawSpec);
  } catch (error) {
    if (error instanceof DesignError) {
      throw new AiError(error.code === "NOT_CUSTOMIZABLE" ? "NOT_AVAILABLE" : "INVALID", error.message);
    }
    throw error;
  }
  if (!checked.context.template.aiEnabled) {
    throw new AiError("NOT_AVAILABLE", "The AI design helper isn't available for this dress.");
  }
  return checked;
}

/** Validates a request and queues a design round, or hands back an earlier identical one. */
export async function createDesignRoundJob(
  db: PrismaClient,
  storage: StorageAdapter,
  actor: Actor,
  rawInput: unknown,
  now: Date = new Date(),
): Promise<QueuedRound> {
  assertCustomer(actor);
  const parsed = requestSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AiError("INVALID", parsed.error.issues[0]?.message ?? "Please check your request.");
  }
  const input = parsed.data;

  // Cheap checks first: none of these cost quota or reach a provider.
  if (findBrandTerm(input.instruction)) {
    throw new AiError("BRAND_LOGO", BRAND_LOGO_MESSAGE);
  }
  const attachmentKeys = [...new Set(input.attachmentKeys)];
  if (attachmentKeys.some((k) => !isSafeObjectKey(k) || !k.startsWith(aiInputPrefix(actor.id)))) {
    throw new AiError("INVALID", "One of the attached photos isn't yours.");
  }
  if (attachmentKeys.length > 0) {
    const found = await storage.signReadUrls(BUCKETS.designAssets, attachmentKeys, 60);
    if (found.size !== attachmentKeys.length) {
      throw new AiError("INVALID", "One of the attached photos is missing. Please attach it again.");
    }
  }
  const { spec } = await checkAiDesign(db, storage, actor.id, input.spec);

  if (input.reference) {
    const round = await db.aIRound.findFirst({ where: { id: input.reference.roundId, customerId: actor.id }, select: { options: true } });
    const options = storedOptionsSchema.safeParse(round?.options);
    if (!options.success || input.reference.optionIndex >= options.data.length) {
      throw new AiError("NOT_FOUND", "That option no longer exists.");
    }
  }

  let designId: string | null = null;
  if (input.designId) {
    const design = await db.design.findFirst({ where: { id: input.designId, customerId: actor.id, productId: spec.productId }, select: { id: true } });
    if (!design) {
      throw new AiError("NOT_FOUND", "That design doesn't exist or isn't yours.");
    }
    designId = design.id;
  }

  const generation = input.again && designId ? (await db.aIRound.count({ where: { designId, customerId: actor.id } })) + 1 : 0;
  const instruction = input.instruction.replace(/\s+/g, " ");
  const inputHash = aiInputHash({
    v: 1,
    type: "DESIGN_ROUND",
    customerId: actor.id,
    spec,
    instruction: normalizeInstruction(instruction),
    attachments: [...attachmentKeys].sort(),
    reference: input.reference ?? null,
    generation,
  });

  // Same request as before: hand back the earlier result. No provider call, no quota.
  const cached = await db.aIRound.findFirst({ where: { customerId: actor.id, inputHash }, orderBy: { createdAt: "desc" }, select: { jobId: true, designId: true } });
  if (cached) {
    return { jobId: cached.jobId, designId: designId ?? cached.designId, cached: true };
  }

  return db.$transaction(async (tx) => {
    // One submission at a time per customer, so concurrent requests can't both slip under the quota.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ai-quota:${actor.id}`}, 0))`;

    const inFlight = await tx.aIJob.findFirst({ where: { customerId: actor.id, inputHash, status: { in: [...ACTIVE] } }, select: { id: true, payload: true } });
    const inFlightPayload = designRoundPayloadSchema.safeParse(inFlight?.payload);
    if (inFlight && inFlightPayload.success) {
      return { jobId: inFlight.id, designId: designId ?? inFlightPayload.data.designId, cached: true };
    }

    const since = startOfDhakaDay(now);
    const [rounds, pending, submissions] = await Promise.all([
      tx.aIRound.count({ where: { customerId: actor.id, createdAt: { gte: since } } }),
      tx.aIJob.count({ where: { customerId: actor.id, type: "DESIGN_ROUND", status: { in: [...ACTIVE] } } }),
      tx.aIJob.count({ where: { customerId: actor.id, createdAt: { gte: since } } }),
    ]);
    if (rounds + pending >= DAILY_ROUND_LIMIT) {
      throw new AiError("QUOTA", QUOTA_MESSAGE);
    }
    if (submissions >= DAILY_SUBMISSION_LIMIT) {
      throw new AiError("QUOTA", SUBMISSION_LIMIT_MESSAGE);
    }

    // AI rounds belong to a design; an unsaved design becomes a draft (hidden from My designs).
    const id =
      designId ??
      (
        await tx.design.create({
          data: {
            customerId: actor.id,
            productId: spec.productId,
            templateId: spec.templateId,
            templateVersion: spec.templateVersion,
            spec,
            startedFrom: spec.startedFrom === "photo" ? "PHOTO" : spec.startedFrom === "description" ? "DESCRIPTION" : "SHOP",
            referencePhotoKey: spec.referencePhotoKey ?? null,
            status: "DRAFT",
          },
          select: { id: true },
        })
      ).id;

    const payload = {
      kind: "design_round",
      designId: id,
      productId: spec.productId,
      instruction,
      attachmentKeys,
      reference: input.reference ?? null,
      baseSpec: spec,
      generation,
      seed: inputHash,
    } satisfies DesignRoundPayload;
    const job = await tx.aIJob.create({
      data: { type: "DESIGN_ROUND", customerId: actor.id, payload, inputHash, runAfter: now },
      select: { id: true },
    });
    return { jobId: job.id, designId: id, cached: false };
  });
}

/** Rounds used today (finished rounds plus requests still being made). */
export async function getAiQuota(db: PrismaClient, actor: Actor, now: Date = new Date()): Promise<AiQuota> {
  const since = startOfDhakaDay(now);
  const [rounds, pending] = await Promise.all([
    db.aIRound.count({ where: { customerId: actor.id, createdAt: { gte: since } } }),
    db.aIJob.count({ where: { customerId: actor.id, type: "DESIGN_ROUND", status: { in: [...ACTIVE] } } }),
  ]);
  return quotaFrom(rounds + pending);
}

// ─── reading results ─────────────────────────────────────────────────────────

export type RoundOptionView = { index: number; title: string; summary: string; previewUrl: string | null };
export type RoundView = {
  id: string;
  designId: string;
  instruction: string;
  createdAt: string;
  chosenIndex: number | null;
  options: RoundOptionView[];
};

const roundSelect = { id: true, designId: true, instruction: true, createdAt: true, chosenIndex: true, optionKeys: true, options: true } as const;
type RoundRow = { id: string; designId: string; instruction: string; createdAt: Date; chosenIndex: number | null; optionKeys: string[]; options: unknown };

async function toRoundViews(storage: StorageAdapter, rows: RoundRow[]): Promise<RoundView[]> {
  const urls = await storage.signReadUrls(
    BUCKETS.designAssets,
    rows.flatMap((r) => r.optionKeys.filter(isSafeObjectKey)),
  );
  return rows.map((row) => {
    const options = storedOptionsSchema.safeParse(row.options);
    return {
      id: row.id,
      designId: row.designId,
      instruction: row.instruction,
      createdAt: row.createdAt.toISOString(),
      chosenIndex: row.chosenIndex,
      options: (options.success ? options.data : []).map((option, index) => {
        const key = row.optionKeys[index];
        return { index, title: option.title, summary: option.summary, previewUrl: key ? (urls.get(key) ?? null) : null };
      }),
    };
  });
}

export type JobStatus =
  | { state: "pending"; position: "queued" | "running" }
  | { state: "done"; round: RoundView }
  | { state: "failed"; message: string; code: string | null };

/** The customer's own job. Other customers' jobs look like they don't exist. */
export async function getJobStatus(db: PrismaClient, storage: StorageAdapter, actor: Actor, rawJobId: unknown): Promise<JobStatus> {
  const jobId = z.uuid().safeParse(rawJobId);
  const job = jobId.success
    ? await db.aIJob.findFirst({ where: { id: jobId.data, customerId: actor.id }, select: { status: true, result: true, errorCode: true } })
    : null;
  if (!job) {
    throw new AiError("NOT_FOUND", "That request doesn't exist.");
  }
  switch (job.status) {
    case "QUEUED":
      return { state: "pending", position: "queued" };
    case "RUNNING":
      return { state: "pending", position: "running" };
    case "FAILED":
      return { state: "failed", message: failureMessage(job.errorCode), code: job.errorCode };
    case "SUCCEEDED": {
      const result = designRoundResultSchema.safeParse(job.result);
      const round = result.success
        ? await db.aIRound.findFirst({ where: { id: result.data.roundId, customerId: actor.id }, select: roundSelect })
        : null;
      if (!round) {
        return { state: "failed", message: failureMessage("INTERNAL"), code: "INTERNAL" };
      }
      const [view] = await toRoundViews(storage, [round]);
      return view ? { state: "done", round: view } : { state: "failed", message: failureMessage("INTERNAL"), code: "INTERNAL" };
    }
  }
}

/** Earlier rounds for one of the customer's designs, newest first. */
export async function listRounds(db: PrismaClient, storage: StorageAdapter, actor: Actor, rawDesignId: unknown): Promise<RoundView[]> {
  const designId = z.uuid().safeParse(rawDesignId);
  if (!designId.success) {
    return [];
  }
  const rows = await db.aIRound.findMany({
    where: { designId: designId.data, customerId: actor.id },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: roundSelect,
  });
  return toRoundViews(storage, rows);
}

export type PickedOption = { spec: DesignSpec; price: DesignPrice; imageUrls: Record<string, string> };

/** Turns one option into the customer's working design, after revalidating it against the live template. */
export async function pickOption(db: PrismaClient, storage: StorageAdapter, actor: Actor, rawInput: unknown): Promise<PickedOption> {
  assertCustomer(actor);
  const input = referenceSchema.safeParse(rawInput);
  const round = input.success
    ? await db.aIRound.findFirst({ where: { id: input.data.roundId, customerId: actor.id }, select: { id: true, options: true } })
    : null;
  const options = storedOptionsSchema.safeParse(round?.options);
  const option = input.success && options.success ? options.data[input.data.optionIndex] : undefined;
  if (!round || !input.success || !option) {
    throw new AiError("NOT_FOUND", "That option no longer exists.");
  }
  let checked: CheckedDesign;
  try {
    checked = await checkAiDesign(db, storage, actor.id, option.spec);
  } catch (error) {
    if (error instanceof AiError && error.code === "INVALID") {
      throw new AiError("INVALID", "This option no longer fits the dress's current options. Pick another or generate again.");
    }
    throw error;
  }
  await db.aIRound.update({ where: { id: round.id }, data: { chosenIndex: input.data.optionIndex } });
  const keys = checked.spec.layers.flatMap((l) => (l.kind === "image" ? [l.image.assetKey] : []));
  const urls = await storage.signReadUrls(BUCKETS.designAssets, keys);
  return { spec: checked.spec, price: checked.price, imageUrls: Object.fromEntries(urls) };
}

/** Stores a photo attached to an AI request (re-encoded, metadata stripped). */
export async function uploadAiAttachment(storage: StorageAdapter, actor: Actor, bytes: Uint8Array): Promise<{ key: string; url: string | null }> {
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
  const key = buildObjectKey(BUCKETS.designAssets, { ownerId: actor.id, category: "ai-inputs", extension: image.extension });
  await storage.put(BUCKETS.designAssets, key, image.data, image.contentType);
  const urls = await storage.signReadUrls(BUCKETS.designAssets, [key]);
  return { key, url: urls.get(key) ?? null };
}
