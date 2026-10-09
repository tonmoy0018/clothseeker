import { z } from "zod";

// Courier abstraction: shipments are booked by us; status updates arrive as signed webhooks.

export const courierWebhookEventSchema = z.object({
  eventId: z.string().min(8).max(100),
  trackingNumber: z.string().regex(/^[A-Z0-9]{6,20}$/),
  status: z.enum(["in_transit", "out_for_delivery", "delivered"]),
  note: z.string().max(200).optional(),
});

export type CourierWebhookEvent = z.infer<typeof courierWebhookEventSchema>;

export class CourierWebhookVerificationError extends Error {
  override readonly name = "CourierWebhookVerificationError";
}

export interface CourierProvider {
  readonly name: string;
  readonly carrierLabel: string;
  parseWebhook(rawBody: string, headers: Headers): CourierWebhookEvent;
}
