import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ForbiddenError } from "@/lib/auth/policy";
import { MockPaymentProvider } from "@/lib/payments/mock";
import type { PaymentProvider } from "@/lib/payments/types";
import { addToCart, getCart } from "@/lib/shop/cart";
import { listOrders, payWithMock } from "@/lib/shop/checkout";
import { ShopError } from "@/lib/shop/errors";

import { createProduct, createUser, db, resetDatabaseBeforeEach } from "./helpers";

resetDatabaseBeforeEach();

const provider = new MockPaymentProvider();

async function customerWithCart(stock = 5, quantity = 2) {
  const customer = await createUser();
  const product = await createProduct({ variants: [{ size: "M", color: "Sage", priceMinor: 320_000, stock }] });
  await addToCart(db, customer, { productId: product.id, size: "M", color: "Sage", quantity });
  return { customer, product, variantId: product.variants[0]?.id ?? "" };
}

async function stockOf(variantId: string): Promise<number> {
  return (await db.variant.findUniqueOrThrow({ where: { id: variantId } })).stock;
}

describe("payWithMock", () => {
  it("creates a paid order with snapshots, decrements stock and empties the cart", async () => {
    const { customer, variantId } = await customerWithCart();

    const result = await payWithMock(db, customer, { idempotencyKey: randomUUID() }, provider);

    expect(result.status).toBe("PAID");
    expect(result.orderNumber).toMatch(/^CS-\d{8}-[2-9A-Z]{5}$/);
    const order = await db.order.findUniqueOrThrow({ where: { id: result.orderId }, include: { items: true } });
    expect(order).toMatchObject({ status: "PAID", totalMinor: 640_000, currency: "BDT", customerId: customer.id });
    expect(order.paymentRef).toMatch(/^mock_/);
    expect(order.items).toHaveLength(1);
    expect(order.items[0]).toMatchObject({
      kind: "READY_MADE",
      size: "M",
      colorName: "Sage",
      unitPriceMinor: 320_000,
      quantity: 2,
      status: "PAID",
    });
    expect(await stockOf(variantId)).toBe(3);
    expect((await getCart(db, customer)).lines).toHaveLength(0);
  });

  it("keeps the price snapshot when the catalog price changes later", async () => {
    const { customer, variantId } = await customerWithCart();
    const { orderId } = await payWithMock(db, customer, { idempotencyKey: randomUUID() }, provider);

    await db.variant.update({ where: { id: variantId }, data: { priceMinor: 999_900 } });

    const item = await db.orderItem.findFirstOrThrow({ where: { orderId } });
    expect(item.unitPriceMinor).toBe(320_000);
  });

  it("is idempotent: the same key never creates a second order or charge", async () => {
    const { customer, variantId } = await customerWithCart();
    const idempotencyKey = randomUUID();

    const first = await payWithMock(db, customer, { idempotencyKey }, provider);
    const second = await payWithMock(db, customer, { idempotencyKey }, provider);

    expect(second.orderId).toBe(first.orderId);
    expect(await db.order.count()).toBe(1);
    expect(await stockOf(variantId)).toBe(3);
  });

  it("handles concurrent submissions with the same key", async () => {
    const { customer, variantId } = await customerWithCart();
    const idempotencyKey = randomUUID();

    const results = await Promise.allSettled([
      payWithMock(db, customer, { idempotencyKey }, provider),
      payWithMock(db, customer, { idempotencyKey }, provider),
      payWithMock(db, customer, { idempotencyKey }, provider),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThan(0);
    expect(new Set(fulfilled.map((r) => r.value.orderId)).size).toBe(1);
    expect(await db.order.count()).toBe(1);
    expect(await stockOf(variantId)).toBe(3);
  });

  it("rolls everything back when stock ran out after adding to cart", async () => {
    const { customer, variantId } = await customerWithCart(5, 3);
    await db.variant.update({ where: { id: variantId }, data: { stock: 2 } });

    await expect(payWithMock(db, customer, { idempotencyKey: randomUUID() }, provider)).rejects.toSatisfy(
      (e) => e instanceof ShopError && e.code === "INSUFFICIENT_STOCK",
    );

    expect(await db.order.count()).toBe(0);
    expect(await stockOf(variantId)).toBe(2);
    expect((await getCart(db, customer)).lines).toHaveLength(1);
  });

  it("rejects an empty cart", async () => {
    const customer = await createUser();
    await expect(payWithMock(db, customer, { idempotencyKey: randomUUID() }, provider)).rejects.toSatisfy(
      (e) => e instanceof ShopError && e.code === "CART_EMPTY",
    );
  });

  it("cancels the order and restores stock when payment is declined", async () => {
    const { customer, variantId } = await customerWithCart();
    const declining: PaymentProvider = {
      name: "declining",
      charge: async () => ({ status: "declined", reason: "test" }),
    };

    await expect(payWithMock(db, customer, { idempotencyKey: randomUUID() }, declining)).rejects.toSatisfy(
      (e) => e instanceof ShopError && e.code === "PAYMENT_DECLINED",
    );

    const order = await db.order.findFirstOrThrow({ include: { items: true } });
    expect(order.status).toBe("CANCELLED");
    expect(order.items[0]?.status).toBe("CANCELLED");
    expect(await stockOf(variantId)).toBe(5);
  });

  it("does not let another customer reuse someone else's checkout key", async () => {
    const { customer } = await customerWithCart();
    const other = await createUser();
    const idempotencyKey = randomUUID();
    await payWithMock(db, customer, { idempotencyKey }, provider);

    await expect(payWithMock(db, other, { idempotencyKey }, provider)).rejects.toSatisfy(
      (e) => e instanceof ShopError && e.code === "NOT_FOUND",
    );
  });

  it("does not let admins check out", async () => {
    const admin = await createUser("ADMIN");
    await expect(payWithMock(db, admin, { idempotencyKey: randomUUID() }, provider)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe("listOrders", () => {
  it("returns only the actor's own orders", async () => {
    const { customer: alice } = await customerWithCart();
    const { customer: bob } = await customerWithCart();
    await payWithMock(db, alice, { idempotencyKey: randomUUID() }, provider);

    expect(await listOrders(db, alice)).toHaveLength(1);
    expect(await listOrders(db, bob)).toHaveLength(0);
  });
});
