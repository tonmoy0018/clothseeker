import { randomUUID } from "node:crypto";

import type { Actor } from "@/lib/auth/policy";
import { addDesignToCart, saveDesign } from "@/lib/design/service";
import { placeOrder } from "@/lib/orders/checkout";
import { handlePaymentWebhook } from "@/lib/orders/payments";
import { MOCK_SIGNATURE_HEADER, MockPaymentProvider } from "@/lib/payments/mock";
import { addToCart } from "@/lib/shop/cart";
import type { MemoryStorageAdapter } from "@/lib/storage/memory";

import { TEMPLATE, validSpec } from "../fixtures/design";

import { createProduct, createUser, db } from "./helpers";

export const payments = new MockPaymentProvider("test-webhook-secret-0123456789abcdef");
export const ADDRESS = { name: "Ava Rahman", phone: "01712345678", line1: "House 12, Road 5, Dhanmondi", city: "Dhaka" };

/**
 * A PAID order placed through the real checkout + webhook path.
 * `custom` and `readyMade` choose which lines it contains.
 */
export async function paidOrder(storage: MemoryStorageAdapter, options: { custom?: boolean; readyMade?: boolean; now?: Date } = {}) {
  const { custom = true, readyMade = true, now = new Date() } = options;
  const customer: Actor = await createUser();
  const product = await createProduct({ variants: [{ size: "M", color: "Sage", priceMinor: 320_000, stock: 5 }] });
  const template = await db.customizationTemplate.create({
    data: { productId: product.id, version: 3, config: TEMPLATE, isActive: true, aiEnabled: false },
  });
  if (readyMade) {
    await addToCart(db, customer, { productId: product.id, size: "M", color: "Sage", quantity: 1 });
  }
  if (custom) {
    const saved = await saveDesign(db, storage, customer, { spec: validSpec({ productId: product.id, templateId: template.id }) });
    await addDesignToCart(db, storage, customer, saved.designId);
  }
  const placed = await placeOrder(
    db,
    storage,
    payments,
    customer,
    { idempotencyKey: randomUUID(), zone: "INSIDE_DHAKA", address: ADDRESS, customerNote: "Hem 2 cm shorter" },
    { now, returnUrlFor: (id) => `/account/orders/${id}` },
  );
  const order = await db.order.findUniqueOrThrow({ where: { id: placed.orderId } });
  const body = JSON.stringify({ eventId: `evt_${randomUUID()}`, type: "payment.succeeded", providerRef: order.paymentRef, amountMinor: order.totalMinor, currency: "BDT" });
  await handlePaymentWebhook(db, payments, storage, body, new Headers({ [MOCK_SIGNATURE_HEADER]: payments.sign(body) }), now);
  const items = await db.orderItem.findMany({ where: { orderId: order.id } });
  return {
    customer,
    order: await db.order.findUniqueOrThrow({ where: { id: order.id } }),
    customItem: items.find((i) => i.kind === "CUSTOM_DESIGN"),
    readyItem: items.find((i) => i.kind === "READY_MADE"),
  };
}
