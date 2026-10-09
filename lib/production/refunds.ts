import type { PrismaClient } from "@/lib/db/client";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { PaymentProvider } from "@/lib/payments/types";

// Refunds for items that won't be made (declined, or not accepted within 24 hours).
//
// 1. planItemRefunds() runs INSIDE the transaction that moves the items to REFUNDED: it records
//    PENDING Refund rows. `uniqueKey` makes each item (and each delivery fee) refundable once.
//    When no item of the order is left to fulfil, the delivery fee is refunded too and the
//    order becomes REFUNDED.
// 2. settleRefunds() runs AFTER commit and asks the payment provider to return the money.
//    If the provider fails, the row stays PENDING and retryPendingRefunds() (worker) retries it.

const ENDED = ["CANCELLED", "REFUNDED"] as const;

/** Whether an order has nothing left to fulfil (every item cancelled or refunded). */
export function orderFullyEnded(itemStatuses: readonly string[]): boolean {
  return itemStatuses.length > 0 && itemStatuses.every((s) => (ENDED as readonly string[]).includes(s));
}

export async function planItemRefunds(
  tx: Prisma.TransactionClient,
  input: { orderId: string; itemIds: readonly string[]; reason: string },
): Promise<void> {
  if (input.itemIds.length === 0) {
    return;
  }
  const order = await tx.order.findUniqueOrThrow({
    where: { id: input.orderId },
    select: {
      id: true,
      status: true,
      deliveryFeeMinor: true,
      payments: { where: { status: "SUCCEEDED" }, select: { id: true }, take: 1 },
      items: { select: { id: true, status: true, unitPriceMinor: true, quantity: true } },
    },
  });
  const payment = order.payments[0];
  if (!payment) {
    throw new Error("Refund requested for an order without a successful payment");
  }

  const refunded = order.items.filter((i) => input.itemIds.includes(i.id));
  await tx.refund.createMany({
    data: refunded.map((item) => ({
      uniqueKey: `item:${item.id}`,
      paymentId: payment.id,
      orderId: order.id,
      orderItemId: item.id,
      kind: "ITEM" as const,
      amountMinor: item.unitPriceMinor * item.quantity,
      reason: input.reason,
    })),
    skipDuplicates: true,
  });

  if (orderFullyEnded(order.items.map((i) => i.status))) {
    if (order.deliveryFeeMinor > 0) {
      await tx.refund.createMany({
        data: [
          {
            uniqueKey: `delivery:${payment.id}`,
            paymentId: payment.id,
            orderId: order.id,
            kind: "DELIVERY_FEE",
            amountMinor: order.deliveryFeeMinor,
            reason: "Nothing left to deliver",
          },
        ],
        skipDuplicates: true,
      });
    }
    const updated = await tx.order.updateMany({ where: { id: order.id, status: "PAID" }, data: { status: "REFUNDED" } });
    if (updated.count === 1) {
      await tx.orderEvent.create({
        data: { orderId: order.id, fromStatus: "PAID", toStatus: "REFUNDED", actorType: "SYSTEM", note: "Every item was refunded" },
      });
    }
  }
}

/** Pays out PENDING refunds (optionally only for one order). Returns how many succeeded. */
export async function settleRefunds(db: PrismaClient, provider: PaymentProvider, options: { orderId?: string; limit?: number } = {}): Promise<number> {
  const pending = await db.refund.findMany({
    where: { status: "PENDING", ...(options.orderId ? { orderId: options.orderId } : {}) },
    orderBy: { createdAt: "asc" },
    take: options.limit ?? 50,
    select: { id: true, amountMinor: true, payment: { select: { providerRef: true } } },
  });
  let settled = 0;
  for (const refund of pending) {
    try {
      await provider.refund(refund.payment.providerRef, refund.amountMinor);
    } catch {
      continue; // stays PENDING; retried later
    }
    const updated = await db.refund.updateMany({ where: { id: refund.id, status: "PENDING" }, data: { status: "SUCCEEDED" } });
    settled += updated.count;
  }
  return settled;
}

/** Worker sweep: finish any refund whose provider call failed earlier. */
export function retryPendingRefunds(db: PrismaClient, provider: PaymentProvider): Promise<number> {
  return settleRefunds(db, provider);
}
