import { createHash } from "node:crypto";

import type { ChargeRequest, ChargeResult, PaymentProvider } from "./types";

/**
 * Sandbox provider: approves every valid charge. The payment ref is derived from the
 * idempotency key, so a retried charge returns the same ref, like a real gateway would.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    if (!Number.isSafeInteger(request.amountMinor) || request.amountMinor <= 0) {
      return { status: "declined", reason: "invalid_amount" };
    }
    const digest = createHash("sha256").update(request.idempotencyKey).digest("hex").slice(0, 24);
    return { status: "succeeded", paymentRef: `mock_${digest}` };
  }
}
