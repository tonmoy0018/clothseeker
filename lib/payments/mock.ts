import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  paymentWebhookEventSchema,
  WebhookVerificationError,
  type CreatedPayment,
  type CreatePaymentRequest,
  type PaymentProvider,
  type PaymentWebhookEvent,
} from "./types";

export const MOCK_SIGNATURE_HEADER = "x-mock-signature";

/**
 * Sandbox gateway. Payments are "hosted" on /mock-gateway/[ref] (clearly labelled as simulated);
 * the result reaches us as a webhook signed with HMAC-SHA256, exactly like a real gateway would send it.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";

  constructor(private readonly secret: string) {
    if (secret.length < 32) {
      throw new Error("MOCK_PAYMENT_WEBHOOK_SECRET must be at least 32 characters");
    }
  }

  async createPayment(request: CreatePaymentRequest): Promise<CreatedPayment> {
    // Deterministic per idempotency key, so a retried checkout never creates a second payment.
    const providerRef = `mockpay_${createHash("sha256").update(request.idempotencyKey).digest("hex").slice(0, 24)}`;
    return { providerRef, redirectUrl: `/mock-gateway/${providerRef}?return=${encodeURIComponent(request.returnUrl)}` };
  }

  /** Signature header value for a raw body (used by the simulated gateway and by tests). */
  sign(rawBody: string): string {
    return `sha256=${createHmac("sha256", this.secret).update(rawBody).digest("hex")}`;
  }

  parseWebhook(rawBody: string, headers: Headers): PaymentWebhookEvent {
    const given = headers.get(MOCK_SIGNATURE_HEADER) ?? "";
    const expected = this.sign(rawBody);
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new WebhookVerificationError("Invalid webhook signature");
    }
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw new WebhookVerificationError("Webhook body is not JSON");
    }
    const event = paymentWebhookEventSchema.safeParse(json);
    if (!event.success) {
      throw new WebhookVerificationError("Webhook event has an unexpected shape");
    }
    return event.data;
  }

  async refund(): Promise<{ status: "refunded" }> {
    return { status: "refunded" };
  }
}
