import { randomUUID } from "node:crypto";

import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";

import { ForbiddenError, type Actor } from "@/lib/auth/policy";
import { MOCK_COURIER_SIGNATURE_HEADER, MockCourier } from "@/lib/couriers/mock";
import { CourierWebhookVerificationError } from "@/lib/couriers/types";
import type { PaymentProvider } from "@/lib/payments/types";
import { acceptItem, declineItem, expireOverdueAcceptances } from "@/lib/production/acceptance";
import { ProductionError } from "@/lib/production/errors";
import { approveQc, markReadyToShip, rejectQc, startProduction, submitQc, uploadQcPhoto } from "@/lib/production/production";
import { getAdminOrder, listQueue, queueCounts } from "@/lib/production/queries";
import { retryPendingRefunds } from "@/lib/production/refunds";
import { CourierWebhookError, handleCourierWebhook, shipItem } from "@/lib/production/shipping";
import { BUCKETS } from "@/lib/storage/buckets";
import type { MemoryStorageAdapter } from "@/lib/storage/memory";

import { storageWithTemplateAssets } from "../fixtures/design";

import { createUser, db, resetDatabaseBeforeEach } from "./helpers";
import { paidOrder, payments } from "./order-fixtures";

resetDatabaseBeforeEach();

const courier = new MockCourier("test-courier-secret-0123456789abcdef");
let storage: MemoryStorageAdapter;
let admin: Actor;

beforeEach(async () => {
  storage = await storageWithTemplateAssets();
  admin = await createUser("ADMIN");
});

async function expectProductionError(promise: Promise<unknown>, code: ProductionError["code"]) {
  await expect(promise).rejects.toSatisfy((e) => e instanceof ProductionError && e.code === code);
}

const statusOf = async (id: string) => (await db.orderItem.findUniqueOrThrow({ where: { id } })).status;
const photo = () => sharp({ create: { width: 800, height: 1000, channels: 3, background: "#ddd" } }).jpeg().toBuffer();

function courierUpdate(trackingNumber: string, status: "in_transit" | "out_for_delivery" | "delivered", eventId = `cev_${randomUUID()}`) {
  const body = JSON.stringify({ eventId, trackingNumber, status });
  return handleCourierWebhook(db, courier, body, new Headers({ [MOCK_COURIER_SIGNATURE_HEADER]: courier.sign(body) }));
}

describe("admin only", () => {
  it("refuses every production action for customers", async () => {
    const { customer, customItem, order } = await paidOrder(storage);
    if (!customItem) throw new Error("fixture");
    const bytes = await photo();
    const calls: (() => Promise<unknown>)[] = [
      () => acceptItem(db, customer, customItem.id),
      () => declineItem(db, payments, customer, { itemId: customItem.id, reason: "No fabric" }),
      () => startProduction(db, customer, customItem.id),
      () => uploadQcPhoto(db, storage, customer, { itemId: customItem.id, side: "FRONT" }, bytes),
      () => submitQc(db, customer, customItem.id),
      () => shipItem(db, courier, customer, { itemId: customItem.id }),
      () => listQueue(db, customer, {}),
      () => getAdminOrder(db, customer, order.id),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await statusOf(customItem.id)).toBe("AWAITING_ACCEPTANCE");
  });
});

describe("acceptance and refunds", () => {
  it("accepts within the window and writes the timeline and audit log", async () => {
    const { customItem } = await paidOrder(storage);
    if (!customItem) throw new Error("fixture");
    await acceptItem(db, admin, customItem.id);
    expect(await statusOf(customItem.id)).toBe("ACCEPTED");
    expect(await db.orderEvent.count({ where: { orderItemId: customItem.id, toStatus: "ACCEPTED", actorType: "ADMIN" } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: "order.item.accept", targetId: customItem.id } })).toBe(1);
  });

  it("refuses acceptance after the 24-hour deadline", async () => {
    const { customItem } = await paidOrder(storage);
    if (!customItem?.acceptBy) throw new Error("fixture");
    await expectProductionError(acceptItem(db, admin, customItem.id, new Date(customItem.acceptBy.getTime() + 1000)), "DEADLINE_PASSED");
    expect(await statusOf(customItem.id)).toBe("AWAITING_ACCEPTANCE");
  });

  it("declining refunds the item once and keeps the delivery fee while other items remain", async () => {
    const { customItem, order } = await paidOrder(storage);
    if (!customItem) throw new Error("fixture");
    await declineItem(db, payments, admin, { itemId: customItem.id, reason: "Fabric out of stock" });
    await expectProductionError(declineItem(db, payments, admin, { itemId: customItem.id, reason: "Again" }), "INVALID_STATE");

    const refunds = await db.refund.findMany({ where: { orderId: order.id } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ kind: "ITEM", amountMinor: customItem.unitPriceMinor, status: "SUCCEEDED" });
    expect(await statusOf(customItem.id)).toBe("REFUNDED");
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
  });

  it("refunds the delivery fee and marks the order refunded when nothing is left to deliver", async () => {
    const { customItem, order } = await paidOrder(storage, { readyMade: false });
    if (!customItem) throw new Error("fixture");
    await declineItem(db, payments, admin, { itemId: customItem.id, reason: "Can't make this design" });

    const refunds = await db.refund.findMany({ where: { orderId: order.id }, orderBy: { kind: "asc" } });
    expect(refunds.map((r) => r.kind)).toEqual(["ITEM", "DELIVERY_FEE"]);
    expect(refunds.reduce((sum, r) => sum + r.amountMinor, 0)).toBe(order.totalMinor);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("REFUNDED");
  });

  it("the 24-hour sweep refunds overdue items exactly once", async () => {
    const { customItem, readyItem, order } = await paidOrder(storage);
    if (!customItem?.acceptBy || !readyItem) throw new Error("fixture");
    const later = new Date(customItem.acceptBy.getTime() + 60_000);

    expect(await expireOverdueAcceptances(db, payments, new Date(customItem.acceptBy.getTime() - 60_000))).toBe(0);
    expect(await expireOverdueAcceptances(db, payments, later)).toBe(1);
    expect(await expireOverdueAcceptances(db, payments, later)).toBe(0);

    expect(await statusOf(customItem.id)).toBe("REFUNDED");
    expect(await statusOf(readyItem.id)).toBe("PAID");
    expect(await db.refund.count({ where: { orderId: order.id } })).toBe(1);
    const event = await db.orderEvent.findFirstOrThrow({ where: { orderItemId: customItem.id, toStatus: "REFUNDED" } });
    expect(event).toMatchObject({ actorType: "SYSTEM" });
  });

  it("retries refunds whose provider call failed", async () => {
    const { customItem, order } = await paidOrder(storage);
    if (!customItem) throw new Error("fixture");
    const failing: PaymentProvider = { ...payments, name: "mock", createPayment: payments.createPayment.bind(payments), parseWebhook: payments.parseWebhook.bind(payments), refund: async () => { throw new Error("gateway down"); } };

    await declineItem(db, failing, admin, { itemId: customItem.id, reason: "No fabric" });
    expect((await db.refund.findFirstOrThrow({ where: { orderId: order.id } })).status).toBe("PENDING");

    expect(await retryPendingRefunds(db, payments)).toBe(1);
    expect((await db.refund.findFirstOrThrow({ where: { orderId: order.id } })).status).toBe("SUCCEEDED");
    expect(await retryPendingRefunds(db, payments)).toBe(0);
  });
});

describe("production, QC and shipping", () => {
  it("custom item: accepted → production → QC (front + back) → ready → shipped → delivered by the courier", async () => {
    const { customItem, order } = await paidOrder(storage);
    if (!customItem) throw new Error("fixture");
    await acceptItem(db, admin, customItem.id);
    await startProduction(db, admin, customItem.id);

    await expectProductionError(submitQc(db, admin, customItem.id), "QC_INCOMPLETE");
    const front = await uploadQcPhoto(db, storage, admin, { itemId: customItem.id, side: "FRONT" }, await photo());
    expect(front.key.startsWith(`${order.id}/qc/`)).toBe(true);
    expect(storage.has(BUCKETS.qcPhotos, front.key)).toBe(true);
    await expectProductionError(submitQc(db, admin, customItem.id), "QC_INCOMPLETE");
    await uploadQcPhoto(db, storage, admin, { itemId: customItem.id, side: "BACK" }, await photo());
    await submitQc(db, admin, customItem.id);

    // A failed QC sends it back to production and needs fresh photos.
    await rejectQc(db, admin, { itemId: customItem.id, note: "Loose thread on the hem" });
    expect(await statusOf(customItem.id)).toBe("IN_PRODUCTION");
    await expectProductionError(submitQc(db, admin, customItem.id), "QC_INCOMPLETE");
    await uploadQcPhoto(db, storage, admin, { itemId: customItem.id, side: "FRONT" }, await photo());
    await uploadQcPhoto(db, storage, admin, { itemId: customItem.id, side: "BACK" }, await photo());
    await submitQc(db, admin, customItem.id);
    await approveQc(db, admin, customItem.id);

    const { trackingNumber } = await shipItem(db, courier, admin, { itemId: customItem.id });
    expect(trackingNumber).toMatch(/^MCK[2-9A-Z]{10}$/);
    expect(await courierUpdate(trackingNumber, "in_transit")).toBe("updated");
    expect(await courierUpdate(trackingNumber, "delivered")).toBe("delivered");
    expect(await statusOf(customItem.id)).toBe("DELIVERED");

    const path = (await db.orderEvent.findMany({ where: { orderItemId: customItem.id }, orderBy: { createdAt: "asc" } })).map((e) => e.toStatus);
    expect(path).toEqual([
      "PAID", "AWAITING_ACCEPTANCE", "ACCEPTED", "IN_PRODUCTION", "QC_SUBMITTED", "IN_PRODUCTION",
      "QC_SUBMITTED", "READY_TO_SHIP", "SHIPPED", "DELIVERED",
    ]);
    const delivered = await db.orderEvent.findFirstOrThrow({ where: { orderItemId: customItem.id, toStatus: "DELIVERED" } });
    expect(delivered.actorType).toBe("COURIER");
  });

  it("ready-made item: paid → ready → shipped → delivered", async () => {
    const { readyItem } = await paidOrder(storage, { custom: false });
    if (!readyItem) throw new Error("fixture");
    await markReadyToShip(db, admin, readyItem.id);
    const { trackingNumber } = await shipItem(db, courier, admin, { itemId: readyItem.id });
    await courierUpdate(trackingNumber, "delivered");
    expect(await statusOf(readyItem.id)).toBe("DELIVERED");
  });

  it("refuses skipped or illegal steps", async () => {
    const { customItem, readyItem } = await paidOrder(storage);
    if (!customItem || !readyItem) throw new Error("fixture");
    await expectProductionError(startProduction(db, admin, customItem.id), "INVALID_STATE");
    await expectProductionError(shipItem(db, courier, admin, { itemId: customItem.id }), "INVALID_STATE");
    await expectProductionError(markReadyToShip(db, admin, customItem.id), "INVALID_STATE");
    await expectProductionError(acceptItem(db, admin, readyItem.id), "INVALID_STATE");
    await expectProductionError(uploadQcPhoto(db, storage, admin, { itemId: readyItem.id, side: "FRONT" }, await photo()), "INVALID_STATE");
    expect(await db.shipment.count()).toBe(0);
  });
});

describe("courier webhooks", () => {
  async function shipped() {
    const { readyItem } = await paidOrder(storage, { custom: false });
    if (!readyItem) throw new Error("fixture");
    await markReadyToShip(db, admin, readyItem.id);
    return { itemId: readyItem.id, ...(await shipItem(db, courier, admin, { itemId: readyItem.id })) };
  }

  it("rejects bad signatures and unknown tracking numbers", async () => {
    const { trackingNumber } = await shipped();
    const body = JSON.stringify({ eventId: "cev_12345678", trackingNumber, status: "delivered" });
    await expect(handleCourierWebhook(db, courier, body, new Headers({ [MOCK_COURIER_SIGNATURE_HEADER]: "sha256=00" }))).rejects.toBeInstanceOf(
      CourierWebhookVerificationError,
    );
    await expect(courierUpdate("MCK9999999999", "delivered")).rejects.toBeInstanceOf(CourierWebhookError);
  });

  it("is idempotent per event and never moves backwards", async () => {
    const { itemId, trackingNumber } = await shipped();
    expect(await courierUpdate(trackingNumber, "delivered", "cev_same_event")).toBe("delivered");
    expect(await courierUpdate(trackingNumber, "delivered", "cev_same_event")).toBe("duplicate");
    expect(await courierUpdate(trackingNumber, "in_transit")).toBe("recorded");
    const shipment = await db.shipment.findFirstOrThrow({ where: { trackingNumber } });
    expect(shipment.status).toBe("DELIVERED");
    expect(await statusOf(itemId)).toBe("DELIVERED");
    expect(await db.courierEvent.count({ where: { shipmentId: shipment.id } })).toBe(2);
  });
});

describe("queue", () => {
  it("lists items by tab and counts overdue acceptances", async () => {
    const { customItem, readyItem } = await paidOrder(storage);
    if (!customItem?.acceptBy || !readyItem) throw new Error("fixture");
    expect((await listQueue(db, admin, { tab: "needs_acceptance" })).map((r) => r.itemId)).toEqual([customItem.id]);
    expect((await listQueue(db, admin, { tab: "to_ship" })).map((r) => r.itemId)).toEqual([readyItem.id]);
    expect((await listQueue(db, admin, { tab: "nonsense" })).map((r) => r.itemId)).toEqual([customItem.id]);
    const counts = await queueCounts(db, admin, new Date(customItem.acceptBy.getTime() + 1));
    expect(counts).toMatchObject({ needsAcceptance: 1, overdue: 1, toShip: 1, toMake: 0, qc: 0 });
  });
});
