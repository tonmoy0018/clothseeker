import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { ForbiddenError, type Actor } from "@/lib/auth/policy";
import { addDesignToCart, saveDesign } from "@/lib/design/service";
import { placeOrder } from "@/lib/orders/checkout";
import { OrderError, PaymentWebhookError } from "@/lib/orders/errors";
import { expireStalePendingOrders } from "@/lib/orders/expiry";
import { handlePaymentWebhook } from "@/lib/orders/payments";
import { parsePrintFiles } from "@/lib/orders/print-files";
import { getOrderForCustomer, getPaymentForCustomer, listOrders } from "@/lib/orders/queries";
import { MOCK_SIGNATURE_HEADER, MockPaymentProvider } from "@/lib/payments/mock";
import { WebhookVerificationError } from "@/lib/payments/types";
import { addToCart, getCart } from "@/lib/shop/cart";
import { BUCKETS } from "@/lib/storage/buckets";
import type { MemoryStorageAdapter } from "@/lib/storage/memory";

import { storageWithTemplateAssets, TEMPLATE, validSpec } from "../fixtures/design";

import { createProduct, createUser, db, resetDatabaseBeforeEach } from "./helpers";

resetDatabaseBeforeEach();

const provider = new MockPaymentProvider("test-webhook-secret-0123456789abcdef");
const ADDRESS = { name: "Ava Rahman", phone: "+8801712345678", line1: "House 12, Road 5, Dhanmondi", city: "Dhaka", postalCode: "1205" };
const T0 = new Date("2026-10-08T10:00:00Z");

let storage: MemoryStorageAdapter;
beforeEach(async () => {
  storage = await storageWithTemplateAssets();
});

const returnUrlFor = (id: string) => `/account/orders/${id}`;

function checkout(actor: Actor, overrides: Record<string, unknown> = {}, now = T0) {
  return placeOrder(db, storage, provider, actor, { idempotencyKey: randomUUID(), zone: "INSIDE_DHAKA", address: ADDRESS, ...overrides }, { now, returnUrlFor });
}

async function sendWebhook(
  type: "payment.succeeded" | "payment.failed",
  providerRef: string,
  amountMinor: number,
  options: { eventId?: string; now?: Date; signature?: string } = {},
) {
  const body = JSON.stringify({ eventId: options.eventId ?? `evt_${randomUUID()}`, type, providerRef, amountMinor, currency: "BDT" });
  const headers = new Headers({ [MOCK_SIGNATURE_HEADER]: options.signature ?? provider.sign(body) });
  return handlePaymentWebhook(db, provider, storage, body, headers, options.now ?? T0);
}

/** A live product with ready-made variants and an active customization template. */
async function catalog() {
  const product = await createProduct({
    variants: [
      { size: "M", color: "Sage", priceMinor: 320_000, stock: 5 },
      { size: "L", color: "Navy", priceMinor: 300_000, stock: 2 },
    ],
  });
  const template = await db.customizationTemplate.create({
    data: { productId: product.id, version: 3, config: TEMPLATE, isActive: true, aiEnabled: false },
  });
  const sage = product.variants.find((v) => v.colorName === "Sage");
  const navy = product.variants.find((v) => v.colorName === "Navy");
  if (!sage || !navy) throw new Error("fixture");
  return { product, template, sage, navy };
}

async function addCustomDesign(customer: Actor, c: Awaited<ReturnType<typeof catalog>>) {
  const saved = await saveDesign(db, storage, customer, { spec: validSpec({ productId: c.product.id, templateId: c.template.id }) });
  await addDesignToCart(db, storage, customer, saved.designId);
  return saved;
}

const stockOf = async (id: string) => (await db.variant.findUniqueOrThrow({ where: { id } })).stock;

describe("placeOrder", () => {
  it("1 line: reserves stock, snapshots the address and totals, creates a payment, keeps the cart", async () => {
    const customer = await createUser();
    const c = await catalog();
    await addToCart(db, customer, { productId: c.product.id, size: "M", color: "Sage", quantity: 2 });

    const placed = await checkout(customer);

    expect(placed.redirectUrl).toMatch(/^\/mock-gateway\/mockpay_/);
    const order = await db.order.findUniqueOrThrow({ where: { id: placed.orderId }, include: { items: true, payments: true } });
    expect(order).toMatchObject({
      status: "PENDING_PAYMENT",
      subtotalMinor: 640_000,
      deliveryFeeMinor: 8_000,
      totalMinor: 648_000,
      shippingPhone: "01712345678",
      shippingCity: "Dhaka",
      deliveryZone: "INSIDE_DHAKA",
    });
    expect(order.expiresAt?.getTime()).toBe(T0.getTime() + 30 * 60 * 1000);
    expect(order.items).toHaveLength(1);
    expect(order.payments[0]).toMatchObject({ status: "PENDING", amountMinor: 648_000 });
    expect(await stockOf(c.sage.id)).toBe(3);
    expect((await getCart(db, storage, customer)).lines).toHaveLength(1);
  });

  it("2 lines (ready-made + custom): freezes the design with a preview and 300 DPI print files", async () => {
    const customer = await createUser();
    const c = await catalog();
    await addToCart(db, customer, { productId: c.product.id, size: "L", color: "Navy", quantity: 1 });
    await addCustomDesign(customer, c);

    const placed = await checkout(customer, { zone: "OUTSIDE_DHAKA" });

    const order = await db.order.findUniqueOrThrow({ where: { id: placed.orderId }, include: { items: true } });
    // Custom: base = cheapest size-M variant (৳3,200) + square 150 + midi 200 + pattern 200 + text 150 + decoration 100.
    expect(order.totalMinor).toBe(300_000 + 400_000 + 15_000);
    const custom = order.items.find((i) => i.kind === "CUSTOM_DESIGN");
    if (!custom) throw new Error("missing custom item");
    expect(custom).toMatchObject({ unitPriceMinor: 400_000, quantity: 1, size: "M" });
    expect(custom.designSpec).toMatchObject({ templateVersion: 3, parts: { skirt: { color: "#1f6f50" } } });
    expect(custom.previewKey?.startsWith(`${customer.id}/orders/`)).toBe(true);
    expect(custom.previewKey ? storage.has(BUCKETS.designAssets, custom.previewKey) : false).toBe(true);
    const files = parsePrintFiles(custom.printFiles);
    expect(files.map((f) => [f.areaId, f.widthPx, f.heightPx])).toEqual([["front-chest", 2362, 1772]]);
    expect(files.every((f) => storage.has(BUCKETS.designAssets, f.key))).toBe(true);
  });

  it("3 lines: totals add up across mixed kinds", async () => {
    const customer = await createUser();
    const c = await catalog();
    await addToCart(db, customer, { productId: c.product.id, size: "M", color: "Sage", quantity: 1 });
    await addToCart(db, customer, { productId: c.product.id, size: "L", color: "Navy", quantity: 2 });
    await addCustomDesign(customer, c);

    const placed = await checkout(customer);
    const order = await db.order.findUniqueOrThrow({ where: { id: placed.orderId }, include: { items: true } });
    expect(order.items).toHaveLength(3);
    expect(order.subtotalMinor).toBe(320_000 + 2 * 300_000 + 400_000);
    expect(order.totalMinor).toBe(order.subtotalMinor + 8_000);
  });

  it("is idempotent: the same key resumes the same order without re-reserving or re-rendering", async () => {
    const customer = await createUser();
    const c = await catalog();
    await addToCart(db, customer, { productId: c.product.id, size: "M", color: "Sage", quantity: 1 });
    await addCustomDesign(customer, c);
    const idempotencyKey = randomUUID();

    const first = await checkout(customer, { idempotencyKey });
    const objectsAfterFirst = storage.objects.size;
    const second = await checkout(customer, { idempotencyKey });

    expect(second).toMatchObject({ orderId: first.orderId, redirectUrl: first.redirectUrl, reused: true });
    expect(await db.order.count()).toBe(1);
    expect(await db.payment.count()).toBe(1);
    expect(await stockOf(c.sage.id)).toBe(4);
    expect(storage.objects.size).toBe(objectsAfterFirst);
  });

  it("rolls back completely (including rendered files) when stock ran out", async () => {
    const customer = await createUser();
    const c = await catalog();
    await addToCart(db, customer, { productId: c.product.id, size: "L", color: "Navy", quantity: 2 });
    await addCustomDesign(customer, c);
    await db.variant.update({ where: { id: c.navy.id }, data: { stock: 1 } });
    const before = storage.objects.size;

    await expect(checkout(customer)).rejects.toSatisfy((e) => e instanceof OrderError && e.code === "INSUFFICIENT_STOCK");
    expect(await db.order.count()).toBe(0);
    expect(await stockOf(c.navy.id)).toBe(1);
    expect(storage.objects.size).toBe(before);
  });

  it("refuses empty carts, bad addresses, designs that no longer fit the template, and admins", async () => {
    const customer = await createUser();
    await expect(checkout(customer)).rejects.toSatisfy((e) => e instanceof OrderError && e.code === "CART_EMPTY");
    await expect(checkout(customer, { address: { ...ADDRESS, phone: "12345" } })).rejects.toBeInstanceOf(ZodError);

    const c = await catalog();
    await addCustomDesign(customer, c);
    await db.customizationTemplate.update({
      where: { id: c.template.id },
      data: { config: { ...TEMPLATE, allowedFonts: ["inter"] } }, // the design uses Dancing Script
    });
    await expect(checkout(customer)).rejects.toSatisfy((e) => e instanceof OrderError && e.code === "CART_CHANGED");

    await expect(checkout(await createUser("ADMIN"))).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("payment webhooks", () => {
  async function pendingOrder() {
    const customer = await createUser();
    const c = await catalog();
    await addToCart(db, customer, { productId: c.product.id, size: "M", color: "Sage", quantity: 1 });
    const saved = await addCustomDesign(customer, c);
    const placed = await checkout(customer);
    const order = await db.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    return { customer, c, saved, order, providerRef: order.paymentRef ?? "" };
  }

  it("success: pays the order, starts custom items' 24 h acceptance window, marks designs ordered, clears the cart", async () => {
    const { customer, saved, order, providerRef } = await pendingOrder();

    expect(await sendWebhook("payment.succeeded", providerRef, order.totalMinor)).toBe("paid");

    const paid = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true, payments: true } });
    expect(paid.status).toBe("PAID");
    expect(paid.payments[0]?.status).toBe("SUCCEEDED");
    const ready = paid.items.find((i) => i.kind === "READY_MADE");
    const custom = paid.items.find((i) => i.kind === "CUSTOM_DESIGN");
    expect(ready?.status).toBe("PAID");
    expect(custom?.status).toBe("AWAITING_ACCEPTANCE");
    expect(custom?.acceptBy?.getTime()).toBe(T0.getTime() + 24 * 3600 * 1000);
    expect((await db.design.findUniqueOrThrow({ where: { id: saved.designId } })).status).toBe("ORDERED");
    expect((await getCart(db, storage, customer)).lines).toHaveLength(0);
    const events = await db.orderEvent.findMany({ where: { orderId: order.id } });
    expect(events.map((e) => e.toStatus)).toEqual(expect.arrayContaining(["PENDING_PAYMENT", "PAID", "AWAITING_ACCEPTANCE"]));
  });

  it("processes a duplicate event once, and ignores later events for an already-paid payment", async () => {
    const { order, providerRef } = await pendingOrder();
    const eventId = `evt_${randomUUID()}`;

    expect(await sendWebhook("payment.succeeded", providerRef, order.totalMinor, { eventId })).toBe("paid");
    const eventsAfterFirst = await db.orderEvent.count();
    expect(await sendWebhook("payment.succeeded", providerRef, order.totalMinor, { eventId })).toBe("duplicate");
    expect(await sendWebhook("payment.succeeded", providerRef, order.totalMinor)).toBe("ignored");
    expect(await sendWebhook("payment.failed", providerRef, order.totalMinor)).toBe("ignored");

    expect(await db.orderEvent.count()).toBe(eventsAfterFirst);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
  });

  it("handles concurrent deliveries of the same event", async () => {
    const { order, providerRef } = await pendingOrder();
    const eventId = `evt_${randomUUID()}`;
    const results = await Promise.all([1, 2, 3].map(() => sendWebhook("payment.succeeded", providerRef, order.totalMinor, { eventId })));
    expect(results.filter((r) => r === "paid")).toHaveLength(1);
    expect(await db.paymentEvent.count()).toBe(1);
  });

  it("rejects bad signatures, unknown payments and amount mismatches without changing anything", async () => {
    const { order, providerRef } = await pendingOrder();
    await expect(sendWebhook("payment.succeeded", providerRef, order.totalMinor, { signature: "sha256=00" })).rejects.toBeInstanceOf(
      WebhookVerificationError,
    );
    await expect(sendWebhook("payment.succeeded", "mockpay_unknown", order.totalMinor)).rejects.toSatisfy(
      (e) => e instanceof PaymentWebhookError && e.code === "UNKNOWN_PAYMENT",
    );
    await expect(sendWebhook("payment.succeeded", providerRef, 100)).rejects.toSatisfy(
      (e) => e instanceof PaymentWebhookError && e.code === "AMOUNT_MISMATCH",
    );
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PENDING_PAYMENT");
    expect(await db.paymentEvent.count()).toBe(0);
  });

  it("failure: cancels, returns stock, deletes rendered files and keeps the cart for another try", async () => {
    const { customer, c, order, providerRef } = await pendingOrder();
    const custom = await db.orderItem.findFirstOrThrow({ where: { orderId: order.id, kind: "CUSTOM_DESIGN" } });
    expect(await stockOf(c.sage.id)).toBe(4);

    expect(await sendWebhook("payment.failed", providerRef, order.totalMinor)).toBe("failed");

    const cancelled = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true, payments: true } });
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.items.every((i) => i.status === "CANCELLED")).toBe(true);
    expect(cancelled.payments[0]?.status).toBe("FAILED");
    expect(await stockOf(c.sage.id)).toBe(5);
    expect(custom.previewKey ? storage.has(BUCKETS.designAssets, custom.previewKey) : true).toBe(false);
    expect((await getCart(db, storage, customer)).lines).toHaveLength(2);

    // The customer can check out again straight away.
    await expect(checkout(customer)).resolves.toMatchObject({ reused: false });
  });

  it("expiry: cancels stale orders once, and refunds a payment that arrives afterwards", async () => {
    const { c, order, providerRef } = await pendingOrder();
    const later = new Date(T0.getTime() + 31 * 60 * 1000);

    expect(await expireStalePendingOrders(db, storage, new Date(T0.getTime() + 29 * 60 * 1000))).toBe(0);
    expect(await expireStalePendingOrders(db, storage, later)).toBe(1);
    expect(await expireStalePendingOrders(db, storage, later)).toBe(0);
    expect(await stockOf(c.sage.id)).toBe(5);

    expect(await sendWebhook("payment.succeeded", providerRef, order.totalMinor, { now: later })).toBe("refunded");
    const after = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: true } });
    expect(after.status).toBe("CANCELLED");
    expect(after.payments[0]?.status).toBe("REFUNDED");
  });
});

describe("order access", () => {
  it("customers only see and pay their own orders", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const c = await catalog();
    await addToCart(db, alice, { productId: c.product.id, size: "M", color: "Sage", quantity: 1 });
    const idempotencyKey = randomUUID();
    const placed = await checkout(alice, { idempotencyKey });
    const ref = (await db.order.findUniqueOrThrow({ where: { id: placed.orderId } })).paymentRef ?? "";

    expect(await getOrderForCustomer(db, alice, placed.orderId)).not.toBeNull();
    expect(await getOrderForCustomer(db, bob, placed.orderId)).toBeNull();
    expect(await getPaymentForCustomer(db, alice, ref)).not.toBeNull();
    expect(await getPaymentForCustomer(db, bob, ref)).toBeNull();
    expect(await listOrders(db, bob)).toHaveLength(0);
    await expect(checkout(bob, { idempotencyKey })).rejects.toSatisfy((e) => e instanceof OrderError && e.code === "NOT_FOUND");
  });
});
