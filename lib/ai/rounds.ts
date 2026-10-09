import { z } from "zod";

import { isSafeObjectKey } from "@/lib/storage/object-key";

// Shapes stored in the database by the AI pipeline, shared by the app and the worker.
// Both sides parse with these schemas; nothing read back from JSON columns is trusted blindly.

const key = z.string().max(200).refine(isSafeObjectKey);

export const referenceSchema = z.object({ roundId: z.uuid(), optionIndex: z.number().int().min(0).max(3) });

/** ai_jobs.payload for DESIGN_ROUND jobs. */
export const designRoundPayloadSchema = z.object({
  kind: z.literal("design_round"),
  designId: z.uuid(),
  productId: z.uuid(),
  instruction: z.string().min(3).max(500),
  attachmentKeys: z.array(key).max(3),
  reference: referenceSchema.nullable(),
  /** The customer's design when they asked (validated at submission, revalidated by the worker). */
  baseSpec: z.unknown(),
  generation: z.number().int().min(0),
  seed: z.string().length(64),
});

export type DesignRoundPayload = z.infer<typeof designRoundPayloadSchema>;

/** ai_rounds.options: one entry per option, aligned with ai_rounds.option_keys (the previews). */
export const storedOptionSchema = z.object({
  title: z.string().max(60),
  summary: z.string().max(200),
  /** A DesignSpec that was template-valid when the round was made; revalidated again on pick. */
  spec: z.unknown(),
  motifKey: key.nullable(),
});

export const storedOptionsSchema = z.array(storedOptionSchema).max(4);
export type StoredOption = z.infer<typeof storedOptionSchema>;

/** ai_jobs.result for a finished DESIGN_ROUND. */
export const designRoundResultSchema = z.object({ roundId: z.uuid() });
