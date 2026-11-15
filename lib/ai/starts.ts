import { z } from "zod";

import { assertCustomer, type Actor } from "@/lib/auth/policy";
import { GARMENT_TYPE_IDS } from "@/lib/catalog/garment-types";
import type { PrismaClient } from "@/lib/db/client";
import { customerReferencePrefix, customerSketchRenderPrefix } from "@/lib/design/validate";
import { ImageValidationError, processImage } from "@/lib/media/process-image";
import type { StorageAdapter } from "@/lib/storage/adapter";
import { BUCKETS } from "@/lib/storage/buckets";
import { buildObjectKey, isSafeObjectKey } from "@/lib/storage/object-key";

import { findBrandTerm } from "./brands";
import { AiError, BRAND_LOGO_MESSAGE, failureMessage } from "./errors";
import { aiInputHash, normalizeInstruction } from "./hash";
import { recordLimitHit } from "./limit-hits";
import { cleanSketchNote, SKETCH_NOTE_MAX } from "./sketch";
import { DAILY_ROUND_LIMIT, DAILY_SUBMISSION_LIMIT, QUOTA_MESSAGE, startOfDhakaDay, SUBMISSION_LIMIT_MESSAGE } from "./quota";

// "Start a design from a dress photo or a description" (app side). Queues a DRESS_MATCH job; the
// worker picks the closest customizable dress, prefills a draft design (lib/ai/worker/dress-match.ts)
// and, for descriptions, queues an AI design round on it. With a photo the customer may instead ask for
// their own dress (mode "own", lib/own-dress): made into a private template of its own, to customise or
// to order exactly as it is, both through a quote. The photo may be a drawing: the worker first makes
// SKETCH_RENDERS realistic photos of the garment from it (mode "sketch", lib/ai/sketch.ts), the customer
// picks the closest, and that one becomes their own dress (mode "own" with its `renderKey`).

const key = z.string().max(200).refine(isSafeObjectKey);

export const dressMatchPayloadSchema = z.object({
  kind: z.literal("dress_match"),
  mode: z.enum(["photo", "description", "own", "sketch"]),
  referenceKey: key.nullable(),
  description: z.string().min(10).max(500).nullable(),
  seed: z.string().length(64),
  /**
   * Mode "own": what the garment is ("auto": the AI reads it), and whether to order it exactly as it is
   * (else to customise it). `sketch`: the photo is a drawing, with the customer's `note` on its fabric.
   */
  own: z
    .object({
      garmentType: z.enum([...GARMENT_TYPE_IDS, "auto"]),
      exact: z.boolean(),
      sketch: z.boolean().optional(),
      note: z.string().max(SKETCH_NOTE_MAX).nullable().optional(),
      /** The rendering of the drawing the customer picked (mode "sketch" made it); without one it's rendered here. */
      renderKey: key.optional(),
    })
    .optional(),
  /** Mode "sketch": the drawing's note, and which set of renderings this is ("show me more" asks for the next). */
  renders: z.object({ note: z.string().max(SKETCH_NOTE_MAX).nullable(), round: z.number().int().min(0).max(20) }).optional(),
});
export type DressMatchPayload = z.infer<typeof dressMatchPayloadSchema>;

/** How many renderings of a drawing are made at a time, to pick the closest from. */
export const SKETCH_RENDERS = 3;

/** What a "sketch" job made: the renderings' storage keys (the customer's own sketch-renders/). */
export const sketchRendersResultSchema = z.object({ renders: z.array(key).min(1).max(SKETCH_RENDERS) });
export type SketchRendersResult = z.infer<typeof sketchRendersResultSchema>;

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
    mode: z.literal("own"),
    referenceKey: z.string().max(200),
    garmentType: z.enum([...GARMENT_TYPE_IDS, "auto"]),
    exact: z.boolean(),
    sketch: z.boolean().default(false),
    note: z.string().trim().max(SKETCH_NOTE_MAX, "Keep your note under 200 characters.").optional(),
    renderKey: z.string().max(200).optional(),
  }),
  z.object({
    mode: z.literal("sketch"),
    referenceKey: z.string().max(200),
    note: z.string().trim().max(SKETCH_NOTE_MAX, "Keep your note under 200 characters.").optional(),
    round: z.number().int().min(0).max(20).default(0),
  }),
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
  if (input.mode === "photo" || input.mode === "own" || input.mode === "sketch") {
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

  if ((input.mode === "own" || input.mode === "sketch") && input.note && findBrandTerm(input.note)) {
    throw new AiError("BRAND_LOGO", BRAND_LOGO_MESSAGE);
  }
  // The rendering picked must be one made for this customer, and still there.
  let renderKey: string | undefined;
  if (input.mode === "own" && input.sketch && input.renderKey !== undefined) {
    if (!isSafeObjectKey(input.renderKey) || !input.renderKey.startsWith(customerSketchRenderPrefix(actor.id))) {
      throw new AiError("INVALID", "That picture isn't yours.");
    }
    if ((await storage.signReadUrls(BUCKETS.designAssets, [input.renderKey], 60)).size !== 1) {
      throw new AiError("INVALID", "That picture is missing. Please make the pictures again.");
    }
    renderKey = input.renderKey;
  }
  // A drawing keeps its note (a photo has none); the request's hash, and so its cache, include both.
  const own =
    input.mode === "own"
      ? { garmentType: input.garmentType, exact: input.exact, ...(input.sketch ? { sketch: true, note: cleanSketchNote(input.note), ...(renderKey ? { renderKey } : {}) } : {}) }
      : undefined;
  const renders = input.mode === "sketch" ? { note: cleanSketchNote(input.note), round: input.round } : undefined;
  const inputHash = aiInputHash({
    v: 1,
    type: "DRESS_MATCH",
    customerId: actor.id,
    referenceKey,
    description: description ? normalizeInstruction(description) : null,
    ...(own ? { mode: "own", own } : {}),
    ...(renders ? { mode: "sketch", renders } : {}),
  });
  try {
    return await queueMatch();
  } catch (error) {
    if (error instanceof AiError && error.code === "QUOTA") {
      await recordLimitHit(db, actor.id, error.message === SUBMISSION_LIMIT_MESSAGE ? "SUBMISSIONS" : "DESIGN_ROUND");
    }
    throw error;
  }

  function queueMatch(): Promise<{ jobId: string; cached: boolean }> {
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ai-quota:${actor.id}`}, 0))`;
      const earlier = await tx.aIJob.findFirst({
        where: { customerId: actor.id, type: "DRESS_MATCH", inputHash, status: { in: [...ACTIVE, "SUCCEEDED"] } },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, result: true },
      });
      const earlierResult = dressMatchResultSchema.safeParse(earlier?.result);
      const designStillThere = earlierResult.success ? (await tx.design.count({ where: { id: earlierResult.data.designId, customerId: actor.id } })) === 1 : false;
      // Renderings are made once per drawing, note and round ("show me more" is the next round).
      const rendered = sketchRendersResultSchema.safeParse(earlier?.result).success;
      if (earlier && (earlier.status !== "SUCCEEDED" || designStillThere || rendered)) {
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
      const payload = { kind: "dress_match", mode: input.mode, referenceKey, description, seed: inputHash, ...(own ? { own } : {}), ...(renders ? { renders } : {}) } satisfies DressMatchPayload;
      const job = await tx.aIJob.create({ data: { type: "DRESS_MATCH", customerId: actor.id, payload, inputHash, runAfter: now }, select: { id: true } });
      return { jobId: job.id, cached: false };
    });
  }
}

export type StartStatus =
  | { state: "pending"; position: "queued" | "running" }
  | { state: "done"; result: DressMatchResult }
  /** A drawing's renderings, to pick the closest from (signed for this customer). */
  | { state: "rendered"; renders: { key: string; url: string }[] }
  | { state: "failed"; message: string; code: string | null };

export async function getStartStatus(db: PrismaClient, storage: StorageAdapter, actor: Actor, rawJobId: unknown): Promise<StartStatus> {
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
  const rendered = sketchRendersResultSchema.safeParse(job.result);
  if (rendered.success) {
    const own = rendered.data.renders.filter((k) => k.startsWith(customerSketchRenderPrefix(actor.id)));
    const urls = await storage.signReadUrls(BUCKETS.designAssets, own);
    const renders = own.flatMap((k) => {
      const url = urls.get(k);
      return url ? [{ key: k, url }] : [];
    });
    return renders.length > 0 ? { state: "rendered", renders } : { state: "failed", message: failureMessage("SKETCH_NOT_RENDERED"), code: "SKETCH_NOT_RENDERED" };
  }
  const result = dressMatchResultSchema.safeParse(job.result);
  return result.success ? { state: "done", result: result.data } : { state: "failed", message: failureMessage("INTERNAL"), code: "INTERNAL" };
}
