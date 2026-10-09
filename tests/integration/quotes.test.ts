import { randomUUID } from "node:crypto";

import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";

import { AdminError } from "@/lib/admin/errors";
import { countQuotesNeedingReply, getQuoteForAdmin, listQuotesForAdmin, respondToQuote } from "@/lib/admin/quotes";
import { uploadReferencePhoto } from "@/lib/ai/starts";
import { ForbiddenError, type Actor } from "@/lib/auth/policy";
import { saveDesign } from "@/lib/design/service";
import { placeOrder } from "@/lib/orders/checkout";
import { OrderError } from "@/lib/orders/errors";
import { handlePaymentWebhook } from "@/lib/orders/payments";
import { MOCK_SIGNATURE_HEADER } from "@/lib/payments/mock";
import { acceptQuote, expireQuotes, getMyQuote, listMyQuotes, QuoteError, requestQuote, withdrawQuote } from "@/lib/quotes/service";
import { getCart } from "@/lib/shop/cart";
import { BUCKETS } from "@/lib/storage/buckets";
import type { MemoryStorageAdapter } from "@/lib/storage/memory";

import { parseDesignSpec } from "@/types/design-spec";

import { storageWithTemplateAssets, TEMPLATE, validSpec } from "../fixtures/design";

import { createProduct, createUser, db, resetDatabaseBeforeEach } from "./helpers";
import { ADDRESS, payments } from "./order-fixtures";

resetDatabaseBeforeEach();

let storage: MemoryStorageAdapter;
beforeEach(async () => {
  storage = await storageWithTemplateAssets();
});

const HOUR = 60 * 60 * 1000;
const NOTES = "Please add a high slit on the left like in my photo";

async function product() {
  const p = await createProduct({ variants: [{ size: "M", color: "Sage", priceMinor: 320_000, stock: 3 }] });
  const template = await db.customizationTemplate.create({ data: { productId: p.id, version: 1, config: TEMPLATE, isActive: true, aiEnabled: true } });
  return { product: p, template };
}

/** A saved, photo-started design (the only kind that can be quoted). */
async function photoDesign(customer: Actor, fromPhoto = true) {
  const { product: p, template } = await product();
  const photo = await uploadReferencePhoto(storage, customer, await sharp({ create: { width: 500, height: 700, channels: 3, background: "#722f37" } }).jpeg().toBuffer());
  const spec = validSpec({ productId: p.id, templateId: template.id, ...(fromPhoto ? { startedFrom: "photo" as const, referencePhotoKey: photo.key } : {}) });
  const saved = await saveDesign(db, storage, customer, { spec });
  return { designId: saved.designId, productId: p.id, photoKey: photo.key };
}

async function expectQuoteError(promise: Promise<unknown>, code: QuoteError["code"]) {
  await expect(promise).rejects.toSatisfy((e) => e instanceof QuoteError && e.code === code);
}

async function payFor(customer: Actor, now: Date) {
  const placed = await placeOrder(db, storage, payments, customer, { idempotencyKey: randomUUID(), zone: "INSIDE_DHAKA", address: ADDRESS }, { now, returnUrlFor: (id) => `/account/orders/${id}` });
  const order = await db.order.findUniqueOrThrow({ where: { id: placed.orderId } });
  const body = JSON.stringify({ eventId: `evt_${randomUUID()}`, type: "payment.succeeded", providerRef: order.paymentRef, amountMinor: order.totalMinor, currency: "BDT" });
  await handlePaymentWebhook(db, payments, storage, body, new Headers({ [MOCK_SIGNATURE_HEADER]: payments.sign(body) }), now);
  return order;
}

describe("requesting a quote", () => {
  it("only photo-started, saved designs of the customer's own are eligible", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const admin = await createUser("ADMIN");
    const shopDesign = await photoDesign(alice, false);
    await expectQuoteError(requestQuote(db, storage, alice, { designId: shopDesign.designId, notes: NOTES }), "NOT_ELIGIBLE");

    const design = await photoDesign(alice);
    await expectQuoteError(requestQuote(db, storage, bob, { designId: design.designId, notes: NOTES }), "NOT_FOUND");
    await expectQuoteError(requestQuote(db, storage, alice, { designId: design.designId, notes: "short" }), "INVALID");
    await expect(requestQuote(db, storage, admin, { designId: design.designId, notes: NOTES })).rejects.toBeInstanceOf(ForbiddenError);

    await db.design.update({ where: { id: design.designId }, data: { status: "DRAFT" } });
    await expectQuoteError(requestQuote(db, storage, alice, { designId: design.designId, notes: NOTES }), "NOT_ELIGIBLE");
    expect(await db.quoteRequest.count()).toBe(0);
  });

  it("freezes the design with its own preview and a 24-hour reply deadline; one open quote per design", async () => {
    const customer = await createUser();
    const design = await photoDesign(customer);
    const now = new Date("2026-10-09T09:00:00Z");
    const { quoteId } = await requestQuote(db, storage, customer, { designId: design.designId, notes: NOTES }, now);
    const quote = await db.quoteRequest.findUniqueOrThrow({ where: { id: quoteId } });
    expect(quote).toMatchObject({ status: "REQUESTED", customerId: customer.id, referencePhotoKey: design.photoKey, respondBy: new Date("2026-10-10T09:00:00Z") });
    expect(quote.previewKey?.startsWith(`${customer.id}/quotes/`)).toBe(true);
    expect(storage.has(BUCKETS.designAssets, quote.previewKey ?? "")).toBe(true);

    // Editing the design afterwards doesn't change what was quoted.
    await saveDesign(db, storage, customer, { designId: design.designId, spec: { ...parseDesignSpec(quote.specSnapshot), parts: { skirt: { color: "#1b1b1b" } } } });
    expect((await db.quoteRequest.findUniqueOrThrow({ where: { id: quoteId } })).specSnapshot).toEqual(quote.specSnapshot);

    await expectQuoteError(requestQuote(db, storage, customer, { designId: design.designId, notes: NOTES }, now), "NOT_ELIGIBLE");
    const [view] = await listMyQuotes(db, storage, customer, now);
    expect(view).toMatchObject({ id: quoteId, status: "REQUESTED", priceMinor: null, inCart: false });
    expect(view?.referencePhotoUrl).toMatch(/^memory:\/\//);
  });
});

describe("the team's reply", () => {
  it("only admins can price or decline, only while the request is open, and it's audited", async () => {
    const customer = await createUser();
    const admin = await createUser("ADMIN");
    const design = await photoDesign(customer);
    const now = new Date();
    const { quoteId } = await requestQuote(db, storage, customer, { designId: design.designId, notes: NOTES }, now);

    await expect(respondToQuote(db, customer, { action: "price", quoteId, priceTaka: 1, note: "Cheap!!" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listQuotesForAdmin(db, storage, customer, "needs_reply")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(respondToQuote(db, admin, { action: "price", quoteId, priceTaka: 0, note: "Includes the slit" })).rejects.toBeInstanceOf(AdminError);
    expect(await countQuotesNeedingReply(db, admin, now)).toBe(1);

    await respondToQuote(db, admin, { action: "price", quoteId, priceTaka: "5200.50", note: "Includes the slit and lining" }, now);
    const quote = await db.quoteRequest.findUniqueOrThrow({ where: { id: quoteId } });
    expect(quote).toMatchObject({ status: "QUOTED", priceMinor: 520_050, responseNote: "Includes the slit and lining" });
    expect(quote.expiresAt?.getTime()).toBe(now.getTime() + 7 * 24 * HOUR);
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "quote.priced" } })).toMatchObject({ actorId: admin.id, targetId: quoteId, metadata: { priceMinor: 520_050 } });

    // Already answered: no second reply.
    await expect(respondToQuote(db, admin, { action: "decline", quoteId, note: "Changed our mind" }, now)).rejects.toBeInstanceOf(AdminError);
    const detail = await getQuoteForAdmin(db, storage, admin, quoteId, now);
    expect(detail?.spec?.referencePhotoKey).toBe(design.photoKey);
    expect(JSON.stringify(detail)).not.toContain("@example.test");
  });

  it("a decline closes the request", async () => {
    const customer = await createUser();
    const admin = await createUser("ADMIN");
    const design = await photoDesign(customer);
    const { quoteId } = await requestQuote(db, storage, customer, { designId: design.designId, notes: NOTES });
    await respondToQuote(db, admin, { action: "decline", quoteId, note: "We can't make slits in this fabric." });
    expect(await getMyQuote(db, storage, customer, quoteId)).toMatchObject({ status: "DECLINED", responseNote: "We can't make slits in this fabric." });
    await expectQuoteError(acceptQuote(db, customer, quoteId), "NOT_ELIGIBLE");
  });
});

describe("expiry", () => {
  it("no reply within 24 hours → expired; a price not paid within 7 days → expired and out of the cart", async () => {
    const customer = await createUser();
    const admin = await createUser("ADMIN");
    const a = await photoDesign(customer);
    const b = await photoDesign(customer);
    const t0 = new Date("2026-10-09T09:00:00Z");
    const unanswered = await requestQuote(db, storage, customer, { designId: a.designId, notes: NOTES }, t0);
    const priced = await requestQuote(db, storage, customer, { designId: b.designId, notes: NOTES }, t0);
    await respondToQuote(db, admin, { action: "price", quoteId: priced.quoteId, priceTaka: 5000, note: "Includes the slit" }, new Date(t0.getTime() + 2 * HOUR));
    await acceptQuote(db, customer, priced.quoteId, new Date(t0.getTime() + 3 * HOUR));

    // Just after 24 h: the team can no longer reply; the customer sees it as expired before the sweep runs.
    const late = new Date(t0.getTime() + 24 * HOUR + 1);
    expect((await getMyQuote(db, storage, customer, unanswered.quoteId, late))?.status).toBe("EXPIRED");
    await expect(respondToQuote(db, admin, { action: "price", quoteId: unanswered.quoteId, priceTaka: 5000, note: "Sorry for the wait" }, late)).rejects.toBeInstanceOf(AdminError);
    expect(await expireQuotes(db, late)).toBe(1);
    expect(await expireQuotes(db, late)).toBe(0);

    const afterWeek = new Date(t0.getTime() + 2 * HOUR + 7 * 24 * HOUR + 1);
    expect(await expireQuotes(db, afterWeek)).toBe(1);
    expect((await db.quoteRequest.findUniqueOrThrow({ where: { id: priced.quoteId } })).status).toBe("EXPIRED");
    expect(await db.cartItem.count({ where: { quoteRequestId: priced.quoteId } })).toBe(0);
    await expectQuoteError(acceptQuote(db, customer, priced.quoteId, afterWeek), "EXPIRED");
  });
});

describe("accepting and paying", () => {
  it("accept → cart at the quoted price → checkout → paid item starts at ACCEPTED", async () => {
    const customer = await createUser();
    const admin = await createUser("ADMIN");
    const design = await photoDesign(customer);
    const { quoteId } = await requestQuote(db, storage, customer, { designId: design.designId, notes: NOTES });
    await respondToQuote(db, admin, { action: "price", quoteId, priceTaka: 5200, note: "Includes the slit" });

    await acceptQuote(db, customer, quoteId);
    await acceptQuote(db, customer, quoteId); // twice: still one line
    const cart = await getCart(db, storage, customer);
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]).toMatchObject({ kind: "QUOTE", quoteId, unitPriceMinor: 520_000, issue: null });
    expect(cart.canCheckout).toBe(true);

    const order = await payFor(customer, new Date());
    expect(order.subtotalMinor).toBe(520_000);
    const item = await db.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    expect(item).toMatchObject({ kind: "QUOTE", status: "ACCEPTED", quoteRequestId: quoteId, designId: design.designId, unitPriceMinor: 520_000 });
    expect(item.previewKey).not.toBeNull();
    expect((await db.quoteRequest.findUniqueOrThrow({ where: { id: quoteId } })).status).toBe("ACCEPTED");
    expect(await db.cartItem.count()).toBe(0);
    const events = await db.orderEvent.findMany({ where: { orderItemId: item.id }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.toStatus)).toEqual(["PAID", "ACCEPTED"]);
  });

  it("an expired quote can't be checked out, and a withdrawn one leaves the cart", async () => {
    const customer = await createUser();
    const admin = await createUser("ADMIN");
    const design = await photoDesign(customer);
    const t0 = new Date();
    const { quoteId } = await requestQuote(db, storage, customer, { designId: design.designId, notes: NOTES }, t0);
    await respondToQuote(db, admin, { action: "price", quoteId, priceTaka: 5200, note: "Includes the slit" }, t0);
    await acceptQuote(db, customer, quoteId, t0);
    // The price expired while it sat in the cart (sweep not run yet).
    await db.quoteRequest.update({ where: { id: quoteId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await getCart(db, storage, customer)).canCheckout).toBe(false);
    await expect(payFor(customer, new Date())).rejects.toBeInstanceOf(OrderError);

    const other = await photoDesign(customer);
    const second = await requestQuote(db, storage, customer, { designId: other.designId, notes: NOTES });
    await withdrawQuote(db, customer, second.quoteId);
    expect((await db.quoteRequest.findUniqueOrThrow({ where: { id: second.quoteId } })).status).toBe("WITHDRAWN");
    await expectQuoteError(withdrawQuote(db, customer, second.quoteId), "NOT_ELIGIBLE");
  });

  it("customers can only see and act on their own quotes", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const admin = await createUser("ADMIN");
    const design = await photoDesign(alice);
    const { quoteId } = await requestQuote(db, storage, alice, { designId: design.designId, notes: NOTES });
    await respondToQuote(db, admin, { action: "price", quoteId, priceTaka: 5200, note: "Includes the slit" });
    expect(await getMyQuote(db, storage, bob, quoteId)).toBeNull();
    expect(await listMyQuotes(db, storage, bob)).toEqual([]);
    await expectQuoteError(acceptQuote(db, bob, quoteId), "NOT_FOUND");
    await expectQuoteError(withdrawQuote(db, bob, quoteId), "NOT_FOUND");
  });
});
