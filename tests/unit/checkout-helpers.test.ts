import { describe, expect, it } from "vitest";

import { MockPaymentProvider } from "@/lib/payments/mock";
import { generateOrderNumber } from "@/lib/shop/checkout";

describe("generateOrderNumber", () => {
  it("formats date and a 5-character unambiguous code", () => {
    const number = generateOrderNumber(new Date("2026-10-06T08:00:00Z"), () => 0);
    expect(number).toBe("CS-20261006-22222");
    expect(generateOrderNumber(new Date())).toMatch(/^CS-\d{8}-[2-9A-HJ-NP-Z]{5}$/);
  });
});

describe("MockPaymentProvider", () => {
  const provider = new MockPaymentProvider();
  const request = { idempotencyKey: "k-1", amountMinor: 100_000, currency: "BDT", reference: "CS-1" };

  it("returns the same payment ref for the same idempotency key", async () => {
    const a = await provider.charge(request);
    const b = await provider.charge(request);
    expect(a).toEqual(b);
    expect(a.status).toBe("succeeded");
  });

  it("declines invalid amounts", async () => {
    expect((await provider.charge({ ...request, amountMinor: 0 })).status).toBe("declined");
  });
});
