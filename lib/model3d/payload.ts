import { z } from "zod";

import { tryOnSourceSchema } from "@/lib/tryon/payload";

// ai_jobs.payload for GARMENT_MODEL jobs (the 3D view) and ai_jobs.result once done. Shared by the app
// and the worker. The garment is described the same way as for a try-on: a design as it is in the
// editor, or a ready-made item.

export const garmentModelPayloadSchema = z.object({
  kind: z.literal("garment_model"),
  source: tryOnSourceSchema,
  garmentHash: z.string().min(3).max(80),
});

export type GarmentModelPayload = z.infer<typeof garmentModelPayloadSchema>;

/** The model, under the customer's `models/` in design-assets. */
export const garmentModelResultSchema = z.object({ modelKey: z.string().min(10).max(200) });

/** 3D views a customer may ask for per Dhaka day (each runs the model for 10–30 s on the worker's machine). */
export const MODEL3D_DAILY_LIMIT = 5;
export const MODEL3D_QUOTA_MESSAGE = `You've made today's ${MODEL3D_DAILY_LIMIT} 3D views. They reset at midnight (Dhaka time).`;

/** Where a customer's models live: only keys under it are signed for them. */
export function customerModelPrefix(customerId: string): string {
  return `${customerId.toLowerCase()}/models/`;
}
