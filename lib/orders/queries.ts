import { z } from "zod";

import type { Actor } from "@/lib/auth/policy";
import type { PrismaClient } from "@/lib/db/client";

import { parsePrintFiles, type StoredPrintFile } from "./print-files";

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
    select: { id: true, number: true, status: true, totalMinor: true, createdAt: true, items: { select: { quantity: true } } },
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

const orderDetailSelect = {
  id: true,
  number: true,
  status: true,
  createdAt: true,
  paidAt: true,
  expiresAt: true,
  subtotalMinor: true,
  deliveryFeeMinor: true,
  totalMinor: true,
  deliveryZone: true,
  paymentRef: true,
  idempotencyKey: true,
  shippingName: true,
  shippingPhone: true,
  shippingLine1: true,
  shippingLine2: true,
  shippingCity: true,
  shippingPostalCode: true,
  items: {
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      kind: true,
      productName: true,
      size: true,
      colorName: true,
      unitPriceMinor: true,
      quantity: true,
      status: true,
      acceptBy: true,
      previewKey: true,
      printFiles: true,
      shipment: {
        select: {
          carrier: true,
          trackingNumber: true,
          status: true,
          courierEvents: { orderBy: { createdAt: "asc" }, select: { id: true, status: true, note: true, createdAt: true } },
        },
      },
    },
  },
  refunds: { orderBy: { createdAt: "asc" }, select: { id: true, kind: true, amountMinor: true, reason: true, status: true, orderItemId: true } },
  events: {
    orderBy: { createdAt: "asc" },
    select: { id: true, orderItemId: true, fromStatus: true, toStatus: true, actorType: true, note: true, createdAt: true },
  },
  payments: { orderBy: { createdAt: "desc" }, select: { status: true, providerRef: true } },
} as const;

type RawOrderDetail = NonNullable<Awaited<ReturnType<typeof findOrder>>>;

function findOrder(db: PrismaClient, where: { id: string; customerId?: string }) {
  return db.order.findFirst({ where, select: orderDetailSelect });
}

export type OrderDetail = Omit<RawOrderDetail, "items"> & {
  items: (Omit<RawOrderDetail["items"][number], "printFiles"> & { printFiles: StoredPrintFile[] })[];
};

/** One of the actor's own orders, or null (also for other customers' orders). */
export async function getOrderForCustomer(db: PrismaClient, actor: Actor, rawOrderId: unknown): Promise<OrderDetail | null> {
  const orderId = z.uuid().safeParse(rawOrderId);
  if (!orderId.success) {
    return null;
  }
  const order = await findOrder(db, { id: orderId.data, customerId: actor.id });
  return order ? { ...order, items: order.items.map((i) => ({ ...i, printFiles: parsePrintFiles(i.printFiles) })) } : null;
}

/** The payment behind a gateway reference, only for its owner (used by the simulated gateway page). */
export async function getPaymentForCustomer(db: PrismaClient, actor: Actor, providerRef: string) {
  return db.payment.findFirst({
    where: { providerRef, order: { customerId: actor.id } },
    select: {
      providerRef: true,
      status: true,
      amountMinor: true,
      currency: true,
      order: { select: { id: true, number: true, status: true, expiresAt: true } },
    },
  });
}
