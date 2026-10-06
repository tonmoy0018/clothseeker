import { randomInt } from "node:crypto";

import { z } from "zod";

import { assertCustomer, type Actor } from "@/lib/auth/policy";
import type { PrismaClient } from "@/lib/db/client";
import { Prisma } from "@/lib/generated/prisma/client";
import { CURRENCY, lineTotalMinor } from "@/lib/money";
import type { PaymentProvider } from "@/lib/payments/types";

import { ShopError } from "./errors";

// Mock checkout for ready-made items (full checkout with address, custom items and quotes is Phase 4).
//
// Idempotency: the cart page renders a server-generated key. The order row is unique on that key,
// so a double-click or retry finds the existing order instead of creating (or charging) a second one.
//
//   1. reserve:  one transaction — re-price cart, decrement stock conditionally, create a
//                PENDING_PAYMENT order with price/name snapshots, empty the cart
//   2. charge:   call the payment provider with the same idempotency key (outside any transaction)
//   3. finalize: PAID (or CANCELLED + stock restored); guarded so it only ever happens once

export const payWithMockSchema = z.object({ idempotencyKey: z.uuid() });

export type CheckoutResult = { orderId: string; orderNumber: string; status: "PAID" | "CANCELLED" };

export async function payWithMock(
  db: PrismaClient,
  actor: Actor,
  rawInput: z.input<typeof payWithMockSchema>,
  provider: PaymentProvider,
  now: () => Date = () => new Date(),
): Promise<CheckoutResult> {
  assertCustomer(actor);
  const { idempotencyKey } = payWithMockSchema.parse(rawInput);

  let order = await findOrderByKey(db, idempotencyKey);
  if (order && order.customerId !== actor.id) {
    // Keys are random UUIDs; a collision with another customer's key is treated as not found.
    throw new ShopError("NOT_FOUND", "We couldn't find that checkout.");
  }
  if (!order) {
    order = await reserveOrder(db, actor, idempotencyKey, now());
  }
  if (order.status !== "PENDING_PAYMENT") {
    return { orderId: order.id, orderNumber: order.number, status: order.status === "PAID" ? "PAID" : "CANCELLED" };
  }

  const charge = await provider.charge({
    idempotencyKey,
    amountMinor: order.totalMinor,
    currency: order.currency,
    reference: order.number,
  });

  if (charge.status === "succeeded") {
    await db.$transaction(async (tx) => {
      const updated = await tx.order.updateMany({
        where: { id: order.id, status: "PENDING_PAYMENT" },
        data: { status: "PAID", paymentRef: charge.paymentRef, paidAt: now() },
      });
      if (updated.count === 1) {
        await tx.orderItem.updateMany({ where: { orderId: order.id }, data: { status: "PAID" } });
      }
    });
    return { orderId: order.id, orderNumber: order.number, status: "PAID" };
  }

  await cancelAndRestock(db, order.id);
  throw new ShopError("PAYMENT_DECLINED", "Your payment was declined. Your cart items were not charged.");
}

type ReservedOrder = {
  id: string;
  number: string;
  customerId: string;
  status: "PENDING_PAYMENT" | "PAID" | "CANCELLED" | "REFUNDED";
  totalMinor: number;
  currency: string;
};

const orderSelect = {
  id: true,
  number: true,
  customerId: true,
  status: true,
  totalMinor: true,
  currency: true,
} as const;

function findOrderByKey(db: PrismaClient, idempotencyKey: string): Promise<ReservedOrder | null> {
  return db.order.findUnique({ where: { idempotencyKey }, select: orderSelect });
}

async function reserveOrder(db: PrismaClient, actor: Actor, idempotencyKey: string, at: Date): Promise<ReservedOrder> {
  try {
    return await db.$transaction(async (tx) => {
      const items = await tx.cartItem.findMany({
        where: { cart: { customerId: actor.id }, kind: "READY_MADE" },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          quantity: true,
          variant: {
            select: {
              id: true,
              size: true,
              colorName: true,
              priceMinor: true,
              isActive: true,
              product: { select: { name: true, status: true } },
            },
          },
        },
      });
      if (items.length === 0) {
        throw new ShopError("CART_EMPTY", "Your cart is empty.");
      }

      const lines = items.map((item) => {
        const v = item.variant;
        if (!v || !v.isActive || v.product.status !== "ACTIVE") {
          throw new ShopError("CART_CHANGED", "An item in your cart is no longer available. Please review your cart.");
        }
        return { variant: v, quantity: item.quantity };
      });

      // Conditional decrement: fails (count 0) if another order took the stock first.
      for (const line of lines) {
        const reserved = await tx.variant.updateMany({
          where: { id: line.variant.id, isActive: true, stock: { gte: line.quantity } },
          data: { stock: { decrement: line.quantity } },
        });
        if (reserved.count !== 1) {
          throw new ShopError(
            "INSUFFICIENT_STOCK",
            `${line.variant.product.name} (${line.variant.size}, ${line.variant.colorName}) doesn't have enough stock left.`,
          );
        }
      }

      const totalMinor = lines.reduce((sum, l) => sum + lineTotalMinor(l.variant.priceMinor, l.quantity), 0);
      const order = await tx.order.create({
        data: {
          number: generateOrderNumber(at),
          customerId: actor.id,
          status: "PENDING_PAYMENT",
          totalMinor,
          currency: CURRENCY,
          idempotencyKey,
          items: {
            create: lines.map((l) => ({
              kind: "READY_MADE" as const,
              variantId: l.variant.id,
              productName: l.variant.product.name,
              size: l.variant.size,
              colorName: l.variant.colorName,
              unitPriceMinor: l.variant.priceMinor,
              quantity: l.quantity,
              status: "PENDING_PAYMENT" as const,
            })),
          },
        },
        select: orderSelect,
      });

      await tx.cartItem.deleteMany({ where: { id: { in: items.map((i) => i.id) } } });
      return order;
    });
  } catch (error) {
    // A concurrent request with the same key won the race: use its order.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await findOrderByKey(db, idempotencyKey);
      if (existing && existing.customerId === actor.id) {
        return existing;
      }
    }
    throw error;
  }
}

async function cancelAndRestock(db: PrismaClient, orderId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const cancelled = await tx.order.updateMany({
      where: { id: orderId, status: "PENDING_PAYMENT" },
      data: { status: "CANCELLED" },
    });
    if (cancelled.count !== 1) {
      return;
    }
    const items = await tx.orderItem.findMany({ where: { orderId }, select: { variantId: true, quantity: true } });
    for (const item of items) {
      if (item.variantId) {
        await tx.variant.update({ where: { id: item.variantId }, data: { stock: { increment: item.quantity } } });
      }
    }
    await tx.orderItem.updateMany({ where: { orderId }, data: { status: "CANCELLED" } });
  });
}

const ORDER_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** e.g. CS-20261006-7K3QX. Human-friendly; uniqueness is enforced by the database. */
export function generateOrderNumber(at: Date, random: (max: number) => number = randomInt): string {
  const date = at.toISOString().slice(0, 10).replaceAll("-", "");
  let code = "";
  for (let i = 0; i < 5; i += 1) {
    code += ORDER_CODE_ALPHABET[random(ORDER_CODE_ALPHABET.length)];
  }
  return `CS-${date}-${code}`;
}

export type OrderSummary = {
  id: string;
  number: string;
  status: string;
  totalMinor: number;
  itemCount: number;
  createdAt: Date;
};

/** Orders belonging to the actor only. */
export async function listOrders(db: PrismaClient, actor: Actor): Promise<OrderSummary[]> {
  const orders = await db.order.findMany({
    where: { customerId: actor.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      number: true,
      status: true,
      totalMinor: true,
      createdAt: true,
      items: { select: { quantity: true } },
    },
  });
  return orders.map((o) => ({
    id: o.id,
    number: o.number,
    status: o.status,
    totalMinor: o.totalMinor,
    itemCount: o.items.reduce((sum, i) => sum + i.quantity, 0),
    createdAt: o.createdAt,
  }));
}
