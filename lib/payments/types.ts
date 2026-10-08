import { z } from "zod";

// Payment gateway abstraction (redirect + webhook, like real gateways such as SSLCommerz or bKash).
// Checkout depends only on this interface, so a real sandbox provider can replace the mock.

export type CreatePaymentRequest = {
  orderId: string;
  orderNumber: string;
  amountMinor: number;
  currency: string;
  /** Same key → same payment. Providers must not create a second payment for a repeated key. */
  idempotencyKey: string;
  /** Where the gateway sends the customer back after paying (or giving up). */
  returnUrl: string;
};

export type CreatedPayment = { providerRef: string; redirectUrl: string };

export const paymentWebhookEventSchema = z.object({
  /** Unique per event; used to process each event at most once. */
  eventId: z.string().min(8).max(100),
  type: z.enum(["payment.succeeded", "payment.failed"]),
  providerRef: z.string().min(4).max(100),
  amountMinor: z.number().int().positive(),
  currency: z.string().length(3),
});

export type PaymentWebhookEvent = z.infer<typeof paymentWebhookEventSchema>;

export class WebhookVerificationError extends Error {
  override readonly name = "WebhookVerificationError";
}

export interface PaymentProvider {
  readonly name: string;
  createPayment(request: CreatePaymentRequest): Promise<CreatedPayment>;
  /** Verifies the signature and parses the event. Throws WebhookVerificationError if anything is off. */
  parseWebhook(rawBody: string, headers: Headers): PaymentWebhookEvent;
  refund(providerRef: string, amountMinor: number): Promise<{ status: "refunded" }>;
}
