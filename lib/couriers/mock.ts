import { createHmac, timingSafeEqual } from "node:crypto";

import { courierWebhookEventSchema, CourierWebhookVerificationError, type CourierProvider, type CourierWebhookEvent } from "./types";

export const MOCK_COURIER_SIGNATURE_HEADER = "x-mock-courier-signature";

/** Simulated courier ("Mock Courier"). Updates are HMAC-SHA256 signed like a real courier's webhooks. */
export class MockCourier implements CourierProvider {
  readonly name = "mock";
  readonly carrierLabel = "Mock Courier";

  constructor(private readonly secret: string) {
    if (secret.length < 32) {
      throw new Error("MOCK_COURIER_WEBHOOK_SECRET must be at least 32 characters");
    }
  }

  sign(rawBody: string): string {
    return `sha256=${createHmac("sha256", this.secret).update(rawBody).digest("hex")}`;
  }

  parseWebhook(rawBody: string, headers: Headers): CourierWebhookEvent {
    const given = Buffer.from(headers.get(MOCK_COURIER_SIGNATURE_HEADER) ?? "");
    const expected = Buffer.from(this.sign(rawBody));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new CourierWebhookVerificationError("Invalid courier signature");
    }
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw new CourierWebhookVerificationError("Courier webhook body is not JSON");
    }
    const event = courierWebhookEventSchema.safeParse(json);
    if (!event.success) {
      throw new CourierWebhookVerificationError("Courier event has an unexpected shape");
    }
    return event.data;
  }
}
