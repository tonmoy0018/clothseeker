import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { respondToQuote } from "@/lib/admin/quotes";
import { resolveDispute } from "@/lib/admin/disputes";
import { openDispute } from "@/lib/disputes/service";
import { MemoryEmailProvider } from "@/lib/notifications/providers";
import { MAX_EMAIL_ATTEMPTS, sendQueuedEmails } from "@/lib/notifications/sender";
import { handlePaymentWebhook } from "@/lib/orders/payments";
import { transitionItems } from "@/lib/orders/transitions";
import { MOCK_SIGNATURE_HEADER } from "@/lib/payments/mock";
import { declineItem } from "@/lib/production/acceptance";
import { expireQuotes } from "@/lib/quotes/service";
import type { MemoryStorageAdapter } from "@/lib/storage/memory";

import { storageWithTemplateAssets, TEMPLATE, validSpec } from "../fixtures/design";

import { createProduct, createUser, db, resetDatabaseBeforeEach } from "./helpers";
import { paidOrder, payments } from "./order-fixtures";

resetDatabaseBeforeEach();

let storage: MemoryStorageAdapter;
beforeEach(async () => {
  storage = await storageWithTemplateAssets();
});

const APP = "http://localhost:3000";
const kinds = async () => (await db.notification.findMany({ orderBy: { createdAt: "asc" }, select: { kind: true } })).map((n) => n.kind);

async function ship(itemId: string) {
  const admin = { type: "ADMIN" as const, id: (await createUser("ADMIN")).id };
  await db.$transaction(async (tx) => {
    await transitionItems(tx, { itemIds: [itemId], to: "READY_TO_SHIP", actor: admin });
    await transitionItems(tx, { itemIds: [itemId], to: "SHIPPED", actor: admin });
  });
  await db.shipment.create({ data: { orderItemId: itemId, carrier: "Mock Courier", trackingNumber: "MCKTEST12345", status: "IN_TRANSIT" } });
}

describe("queueing emails with their events", () => {
  it("a paid order queues one confirmation, even if the webhook arrives twice", async () => {
    const { customer, order } = await paidOrder(storage, { custom: false });
    expect(await kinds()).toEqual(["ORDER_CONFIRMED"]);
    const body = JSON.stringify({ eventId: `evt_${randomUUID()}`, type: "payment.succeeded", providerRef: order.paymentRef, amountMinor: order.totalMinor, currency: "BDT" });
    await handlePaymentWebhook(db, payments, storage, body, new Headers({ [MOCK_SIGNATURE_HEADER]: payments.sign(body) }));
    expect(await db.notification.count()).toBe(1);
    expect(await db.notification.findFirstOrThrow()).toMatchObject({ customerId: customer.id, status: "QUEUED", payload: { orderId: order.id } });
  });

  it("item moves queue their emails once; a rolled-back move queues nothing", async () => {
    const { readyItem } = await paidOrder(storage, { custom: false });
    if (!readyItem) throw new Error("no item");
    await expect(
      db.$transaction(async (tx) => {
        await transitionItems(tx, { itemIds: [readyItem.id], to: "READY_TO_SHIP", actor: { type: "ADMIN", id: null } });
        await transitionItems(tx, { itemIds: [readyItem.id], to: "SHIPPED", actor: { type: "ADMIN", id: null } });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await kinds()).toEqual(["ORDER_CONFIRMED"]);

    await ship(readyItem.id);
    await db.$transaction((tx) => transitionItems(tx, { itemIds: [readyItem.id], to: "SHIPPED", actor: { type: "ADMIN", id: null } }));
    expect(await kinds()).toEqual(["ORDER_CONFIRMED", "SHIPPED"]);
    await db.$transaction((tx) => transitionItems(tx, { itemIds: [readyItem.id], to: "DELIVERED", actor: { type: "COURIER", id: null } }));
    expect(await kinds()).toEqual(["ORDER_CONFIRMED", "SHIPPED", "DELIVERED"]);
  });

  it("declines, disputes and quotes queue the right emails", async () => {
    const admin = await createUser("ADMIN");
    const { customItem } = await paidOrder(storage, { readyMade: false });
    await declineItem(db, payments, admin, { itemId: customItem?.id, reason: "This fabric is out of stock" });
    expect((await kinds()).slice(-1)).toEqual(["ITEM_REFUNDED"]);

    // Dispute → refund says "dispute refunded", not a plain refund; dispute closed isn't "delivered".
    const delivered = await paidOrder(storage, { custom: false });
    const item = delivered.readyItem;
    if (!item) throw new Error("no item");
    await ship(item.id);
    await db.$transaction((tx) => transitionItems(tx, { itemIds: [item.id], to: "DELIVERED", actor: { type: "COURIER", id: null } }));
    const { disputeId } = await openDispute(db, storage, delivered.customer, { itemId: item.id, reason: "The seam came open on the first wear", photos: [] });
    await resolveDispute(db, payments, admin, { disputeId, outcome: "refund", note: "Sorry, refunded" });
    expect((await kinds()).slice(-1)).toEqual(["DISPUTE_REFUNDED"]);

    // Quotes: priced, then expired.
    const customer = await createUser();
    const product = await createProduct({ variants: [{ size: "M", color: "Sage", priceMinor: 320_000, stock: 3 }] });
    const template = await db.customizationTemplate.create({ data: { productId: product.id, version: 1, config: TEMPLATE, isActive: true } });
    const design = await db.design.create({ data: { customerId: customer.id, productId: product.id, spec: validSpec({ productId: product.id, templateId: template.id }), status: "SAVED", startedFrom: "PHOTO" } });
    const quote = await db.quoteRequest.create({ data: { customerId: customer.id, designId: design.id, notes: "Add a slit", specSnapshot: {}, respondBy: new Date(Date.now() + 60_000) } });
    await respondToQuote(db, admin, { action: "price", quoteId: quote.id, priceTaka: 5200, note: "Includes the slit" });
    await expireQuotes(db, new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));
    expect((await kinds()).slice(-2)).toEqual(["QUOTE_READY", "QUOTE_EXPIRED"]);
  });
});

describe("sending", () => {
  it("sends each email once, rendered from current data, with no address or phone", async () => {
    const { customer, order, readyItem } = await paidOrder(storage, { custom: false });
    await db.user.update({ where: { id: customer.id }, data: { name: "Ava Rahman" } });
    if (readyItem) await ship(readyItem.id);
    const provider = new MemoryEmailProvider();

    expect(await sendQueuedEmails(db, { provider, appUrl: APP, from: "ClothSeeker <orders@test>" })).toBe(2);
    expect(await sendQueuedEmails(db, { provider, appUrl: APP, from: "ClothSeeker <orders@test>" })).toBe(0);
    expect(provider.sent.map((e) => e.subject)).toEqual([`Order ${order.number} confirmed`, `Your order ${order.number} is on its way`]);
    const user = await db.user.findUniqueOrThrow({ where: { id: customer.id } });
    expect(provider.sent.every((e) => e.to === user.email)).toBe(true);
    expect(provider.sent[1]?.text).toContain("Tracking: MCKTEST12345");
    expect(provider.sent[0]?.text).toMatch(/^Hi Ava,/);
    expect(provider.sent[0]?.text).toContain(`${APP}/account/orders/${order.id}`);
    for (const email of provider.sent) {
      for (const secret of [order.shippingPhone, order.shippingLine1, order.shippingCity]) {
        expect(email.text + email.html).not.toContain(secret);
      }
    }
    expect(await db.notification.count({ where: { status: "SENT", sentAt: { not: null } } })).toBe(2);
  });

  it("retries with backoff, then gives up", async () => {
    await paidOrder(storage, { custom: false });
    const failing = new MemoryEmailProvider(() => true);
    let now = new Date();
    for (let i = 0; i < MAX_EMAIL_ATTEMPTS; i++) {
      await sendQueuedEmails(db, { provider: failing, appUrl: APP, from: "x@test", now });
      now = new Date(now.getTime() + 60 * 60 * 1000);
    }
    expect(await db.notification.findFirstOrThrow()).toMatchObject({ status: "FAILED", attempts: MAX_EMAIL_ATTEMPTS, error: "Error" });
    expect(await sendQueuedEmails(db, { provider: new MemoryEmailProvider(), appUrl: APP, from: "x@test", now })).toBe(0);
  });

  it("two workers sending at once never send the same email twice", async () => {
    for (let i = 0; i < 3; i++) await paidOrder(storage, { custom: false });
    const a = new MemoryEmailProvider();
    const b = new MemoryEmailProvider();
    await Promise.all([sendQueuedEmails(db, { provider: a, appUrl: APP, from: "x@test" }), sendQueuedEmails(db, { provider: b, appUrl: APP, from: "x@test" })]);
    expect(a.sent.length + b.sent.length).toBe(3);
    expect(await db.notification.count({ where: { status: "SENT" } })).toBe(3);
  });
});
