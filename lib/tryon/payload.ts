import { z } from "zod";

// ai_jobs.payload for TRY_ON jobs and ai_jobs.result once done. Shared by the app and the worker.

export const tryOnSourceSchema = z.discriminatedUnion("kind", [
  /** The design as it is in the editor (validated at submission, revalidated by the worker). */
  z.object({ kind: z.literal("design"), designId: z.uuid().nullable(), spec: z.unknown() }),
  z.object({ kind: z.literal("product"), productId: z.uuid() }),
]);

export const tryOnPayloadSchema = z.object({
  kind: z.literal("try_on"),
  photoId: z.uuid(),
  source: tryOnSourceSchema,
  garmentHash: z.string().min(3).max(80),
});

export type TryOnPayload = z.infer<typeof tryOnPayloadSchema>;

export const tryOnResultSchema = z.object({ resultId: z.uuid() });
