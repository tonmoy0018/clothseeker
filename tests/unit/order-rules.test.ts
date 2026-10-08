import { describe, expect, it } from "vitest";

import type { ActorType, ItemKind, OrderItemStatus } from "@/lib/generated/prisma/enums";
import { bdMobileSchema, checkoutTotals, shippingAddressSchema } from "@/lib/orders/delivery";
import { generateOrderNumber } from "@/lib/orders/number";
import { canTransition, HAPPY_PATH, TRANSITIONS } from "@/lib/orders/transitions";
import { MOCK_SIGNATURE_HEADER, MockPaymentProvider } from "@/lib/payments/mock";
import { WebhookVerificationError } from "@/lib/payments/types";

const KINDS: ItemKind[] = ["READY_MADE", "CUSTOM_DESIGN", "QUOTE"];
const ACTORS: ActorType[] = ["SYSTEM", "ADMIN", "COURIER", "CUSTOMER"];
const STATUSES: OrderItemStatus[] = [
  "PENDING_PAYMENT", "PAID", "AWAITING_ACCEPTANCE", "ACCEPTED", "IN_PRODUCTION", "QC_SUBMITTED",
  "READY_TO_SHIP", "SHIPPED", "DELIVERED", "CANCELLED", "REFUNDED", "DISPUTED",
];

describe("order item transitions", () => {
  it("allows every step of each kind's happy path", () => {
    for (const kind of KINDS) {
      const path = HAPPY_PATH[kind];
      for (let i = 0; i < path.length - 1; i += 1) {
        const from = path[i];
        const to = path[i + 1];
        if (!from || !to) continue;
        expect(ACTORS.some((actor) => canTransition(kind, from, to, actor)), `${kind}: ${from}→${to}`).toBe(true);
      }
    }
  });

  it.each([
    ["READY_MADE", "PAID", "AWAITING_ACCEPTANCE", "SYSTEM"],
    ["READY_MADE", "PENDING_PAYMENT", "SHIPPED", "ADMIN"],
    ["CUSTOM_DESIGN", "PAID", "READY_TO_SHIP", "ADMIN"],
    ["CUSTOM_DESIGN", "AWAITING_ACCEPTANCE", "IN_PRODUCTION", "ADMIN"],
    ["CUSTOM_DESIGN", "DELIVERED", "PAID", "ADMIN"],
    ["CUSTOM_DESIGN", "CANCELLED", "PAID", "SYSTEM"],
    ["QUOTE", "PAID", "AWAITING_ACCEPTANCE", "SYSTEM"],
  ] as const)("rejects illegal %s move %s → %s", (kind, from, to, actor) => {
    expect(canTransition(kind, from, to, actor)).toBe(false);
  });

  it("enforces who may take each step", () => {
    expect(canTransition("CUSTOM_DESIGN", "PENDING_PAYMENT", "PAID", "SYSTEM")).toBe(true);
    expect(canTransition("CUSTOM_DESIGN", "PENDING_PAYMENT", "PAID", "ADMIN")).toBe(false); // only a real payment pays
    expect(canTransition("CUSTOM_DESIGN", "PENDING_PAYMENT", "PAID", "CUSTOMER")).toBe(false);
    expect(canTransition("CUSTOM_DESIGN", "AWAITING_ACCEPTANCE", "ACCEPTED", "ADMIN")).toBe(true);
    expect(canTransition("CUSTOM_DESIGN", "AWAITING_ACCEPTANCE", "ACCEPTED", "SYSTEM")).toBe(false);
    expect(canTransition("CUSTOM_DESIGN", "AWAITING_ACCEPTANCE", "REFUNDED", "SYSTEM")).toBe(true); // 24 h timeout
    expect(canTransition("READY_MADE", "SHIPPED", "DELIVERED", "COURIER")).toBe(true);
    expect(canTransition("READY_MADE", "SHIPPED", "DELIVERED", "CUSTOMER")).toBe(false);
    expect(canTransition("READY_MADE", "DELIVERED", "DISPUTED", "CUSTOMER")).toBe(true);
    expect(canTransition("READY_MADE", "DELIVERED", "DISPUTED", "ADMIN")).toBe(false);
  });

  it("has no transitions out of CANCELLED or REFUNDED", () => {
    for (const kind of KINDS) {
      for (const to of STATUSES) {
        for (const actor of ACTORS) {
          expect(canTransition(kind, "CANCELLED", to, actor)).toBe(false);
          expect(canTransition(kind, "REFUNDED", to, actor)).toBe(false);
        }
      }
      expect(TRANSITIONS[kind].CANCELLED).toBeUndefined();
    }
  });
});

describe("delivery and address", () => {
  it("adds the zone's delivery fee", () => {
    expect(checkoutTotals([320_000, 380_000], "INSIDE_DHAKA")).toEqual({ subtotalMinor: 700_000, deliveryFeeMinor: 8_000, totalMinor: 708_000 });
    expect(checkoutTotals([100_000], "OUTSIDE_DHAKA").totalMinor).toBe(115_000);
    expect(checkoutTotals([], "OUTSIDE_DHAKA").totalMinor).toBe(0);
  });

  it.each([
    ["01712345678", "01712345678"],
    ["+8801712345678", "01712345678"],
    ["8801912-345-678", "01912345678"],
    ["017 1234 5678", "01712345678"],
  ])("normalizes mobile %s", (input, expected) => {
    expect(bdMobileSchema.parse(input)).toBe(expected);
  });

  it.each(["01212345678", "0171234567", "+15551234567", "abc"])("rejects mobile %s", (input) => {
    expect(bdMobileSchema.safeParse(input).success).toBe(false);
  });

  it("requires the delivery basics and keeps optional fields optional", () => {
    const ok = shippingAddressSchema.parse({ name: "Ava Rahman", phone: "01712345678", line1: "House 12, Road 5", line2: "", city: "Dhaka", postalCode: "" });
    expect(ok).toMatchObject({ line2: undefined, postalCode: undefined });
    expect(shippingAddressSchema.safeParse({ name: "A", phone: "01712345678", line1: "x", city: "D" }).success).toBe(false);
    expect(shippingAddressSchema.safeParse({ name: "Ava", phone: "01712345678", line1: "House 1", city: "Dhaka", postalCode: "12345" }).success).toBe(false);
  });
});

describe("mock payment provider", () => {
  const provider = new MockPaymentProvider("test-webhook-secret-0123456789abcdef");
  const event = { eventId: "evt_123456789", type: "payment.succeeded", providerRef: "mockpay_abc", amountMinor: 708_000, currency: "BDT" };

  it("creates a deterministic payment per idempotency key", async () => {
    const request = { orderId: "o", orderNumber: "CS-1", amountMinor: 1, currency: "BDT", returnUrl: "/x" };
    const a = await provider.createPayment({ ...request, idempotencyKey: "key-1" });
    const b = await provider.createPayment({ ...request, idempotencyKey: "key-1" });
    const c = await provider.createPayment({ ...request, idempotencyKey: "key-2" });
    expect(a).toEqual(b);
    expect(a.providerRef).not.toBe(c.providerRef);
    expect(a.redirectUrl).toMatch(/^\/mock-gateway\/mockpay_[0-9a-f]{24}\?return=/);
  });

  it("accepts correctly signed events", () => {
    const body = JSON.stringify(event);
    const headers = new Headers({ [MOCK_SIGNATURE_HEADER]: provider.sign(body) });
    expect(provider.parseWebhook(body, headers)).toEqual(event);
  });

  it("rejects tampered bodies, wrong secrets, missing signatures and malformed events", () => {
    const body = JSON.stringify(event);
    const signature = provider.sign(body);
    const tampered = body.replace("708000", "1");
    const other = new MockPaymentProvider("another-secret-0123456789abcdef0000");
    const cases: [string, Headers][] = [
      [tampered, new Headers({ [MOCK_SIGNATURE_HEADER]: signature })],
      [body, new Headers({ [MOCK_SIGNATURE_HEADER]: other.sign(body) })],
      [body, new Headers()],
      ["{not json", new Headers({ [MOCK_SIGNATURE_HEADER]: provider.sign("{not json") })],
      [JSON.stringify({ ...event, type: "refund.created" }), new Headers({ [MOCK_SIGNATURE_HEADER]: provider.sign(JSON.stringify({ ...event, type: "refund.created" })) })],
    ];
    for (const [raw, headers] of cases) {
      expect(() => provider.parseWebhook(raw, headers)).toThrow(WebhookVerificationError);
    }
  });

  it("refuses short secrets", () => {
    expect(() => new MockPaymentProvider("short")).toThrow();
  });
});

describe("generateOrderNumber", () => {
  it("formats date and an unambiguous code", () => {
    expect(generateOrderNumber(new Date("2026-10-06T08:00:00Z"), () => 0)).toBe("CS-20261006-22222");
    expect(generateOrderNumber(new Date())).toMatch(/^CS-\d{8}-[2-9A-HJ-NP-Z]{5}$/);
  });
});
