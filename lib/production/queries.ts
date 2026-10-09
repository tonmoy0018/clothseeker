import { z } from "zod";

import { assertAdmin, type Actor } from "@/lib/auth/policy";
import type { PrismaClient } from "@/lib/db/client";
import type { Prisma } from "@/lib/generated/prisma/client";
import { ItemKind, type OrderItemStatus } from "@/lib/generated/prisma/enums";
import { parsePrintFiles, type StoredPrintFile } from "@/lib/orders/print-files";

// Read models for the team's order screens. Admin only.

export const QUEUE_TABS = {
  needs_acceptance: { label: "Needs acceptance", statuses: ["AWAITING_ACCEPTANCE"] },
  to_make: { label: "To make", statuses: ["ACCEPTED", "IN_PRODUCTION"] },
  qc: { label: "Quality check", statuses: ["QC_SUBMITTED"] },
  to_ship: { label: "To ship", statuses: ["PAID", "READY_TO_SHIP"] },
  shipped: { label: "Shipped", statuses: ["SHIPPED"] },
  all: {
    label: "All",
    statuses: ["PAID", "AWAITING_ACCEPTANCE", "ACCEPTED", "IN_PRODUCTION", "QC_SUBMITTED", "READY_TO_SHIP", "SHIPPED", "DELIVERED", "REFUNDED", "DISPUTED"],
  },
} as const satisfies Record<string, { label: string; statuses: readonly OrderItemStatus[] }>;

export type QueueTab = keyof typeof QUEUE_TABS;
const TAB_IDS = ["needs_acceptance", "to_make", "qc", "to_ship", "shipped", "all"] as const satisfies readonly QueueTab[];

export const queueFiltersSchema = z.object({
  tab: z.enum(TAB_IDS).catch("needs_acceptance"),
  kind: z.enum(ItemKind).optional().catch(undefined),
  q: z.string().trim().max(40).optional().catch(undefined),
});

export type QueueRow = {
  itemId: string;
  orderId: string;
  orderNumber: string;
  productName: string;
  kind: ItemKind;
  size: string;
  colorName: string | null;
  quantity: number;
  status: OrderItemStatus;
  acceptBy: Date | null;
  paidAt: Date | null;
  previewKey: string | null;
};

export async function listQueue(db: PrismaClient, actor: Actor, rawFilters: unknown): Promise<QueueRow[]> {
  assertAdmin(actor);
  const filters = queueFiltersSchema.parse(rawFilters ?? {});
  const where: Prisma.OrderItemWhereInput = {
    status: { in: [...QUEUE_TABS[filters.tab].statuses] },
    ...(filters.kind ? { kind: filters.kind } : {}),
    ...(filters.q ? { order: { number: { contains: filters.q.toUpperCase() } } } : {}),
  };
  const items = await db.orderItem.findMany({
    where,
    orderBy: filters.tab === "needs_acceptance" ? [{ acceptBy: "asc" }] : [{ updatedAt: "asc" }],
    take: 200,
    select: {
      id: true,
      orderId: true,
      productName: true,
      kind: true,
      size: true,
      colorName: true,
      quantity: true,
      status: true,
      acceptBy: true,
      previewKey: true,
      order: { select: { number: true, paidAt: true } },
    },
  });
  return items.map((i) => ({
    itemId: i.id,
    orderId: i.orderId,
    orderNumber: i.order.number,
    productName: i.productName,
    kind: i.kind,
    size: i.size,
    colorName: i.colorName,
    quantity: i.quantity,
    status: i.status,
    acceptBy: i.acceptBy,
    paidAt: i.order.paidAt,
    previewKey: i.previewKey,
  }));
}

export type QueueCounts = { needsAcceptance: number; overdue: number; toMake: number; qc: number; toShip: number };

export async function queueCounts(db: PrismaClient, actor: Actor, now: Date): Promise<QueueCounts> {
  assertAdmin(actor);
  const count = (statuses: readonly OrderItemStatus[], extra: Prisma.OrderItemWhereInput = {}) =>
    db.orderItem.count({ where: { status: { in: [...statuses] }, ...extra } });
  const [needsAcceptance, overdue, toMake, qc, toShip] = await Promise.all([
    count(QUEUE_TABS.needs_acceptance.statuses),
    count(QUEUE_TABS.needs_acceptance.statuses, { acceptBy: { lt: now } }),
    count(QUEUE_TABS.to_make.statuses),
    count(QUEUE_TABS.qc.statuses),
    count(QUEUE_TABS.to_ship.statuses),
  ]);
  return { needsAcceptance, overdue, toMake, qc, toShip };
}

const adminOrderSelect = {
  id: true,
  number: true,
  status: true,
  createdAt: true,
  paidAt: true,
  subtotalMinor: true,
  deliveryFeeMinor: true,
  totalMinor: true,
  deliveryZone: true,
  customerNote: true,
  shippingName: true,
  shippingPhone: true,
  shippingLine1: true,
  shippingLine2: true,
  shippingCity: true,
  shippingPostalCode: true,
  payments: { orderBy: { createdAt: "desc" }, select: { status: true, providerRef: true, amountMinor: true } },
  refunds: { orderBy: { createdAt: "asc" }, select: { id: true, kind: true, amountMinor: true, reason: true, status: true, orderItemId: true } },
  events: {
    orderBy: { createdAt: "asc" },
    select: { id: true, orderItemId: true, toStatus: true, actorType: true, note: true, createdAt: true },
  },
  items: {
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      kind: true,
      productName: true,
      size: true,
      colorName: true,
      quantity: true,
      unitPriceMinor: true,
      status: true,
      acceptBy: true,
      previewKey: true,
      printFiles: true,
      designSpec: true,
      design: { select: { productId: true } },
      variant: { select: { productId: true } },
      qcPhotos: { orderBy: { createdAt: "desc" }, select: { id: true, side: true, storageKey: true, createdAt: true } },
      shipment: {
        select: {
          carrier: true,
          trackingNumber: true,
          status: true,
          shippedAt: true,
          deliveredAt: true,
          courierEvents: { orderBy: { createdAt: "asc" }, select: { id: true, status: true, note: true, createdAt: true } },
        },
      },
    },
  },
} as const;

type RawAdminOrder = NonNullable<Awaited<ReturnType<typeof findAdminOrder>>>;

function findAdminOrder(db: PrismaClient, id: string) {
  return db.order.findUnique({ where: { id }, select: adminOrderSelect });
}

export type AdminOrder = Omit<RawAdminOrder, "items"> & {
  items: (Omit<RawAdminOrder["items"][number], "printFiles"> & { printFiles: StoredPrintFile[] })[];
};

export async function getAdminOrder(db: PrismaClient, actor: Actor, rawOrderId: unknown): Promise<AdminOrder | null> {
  assertAdmin(actor);
  const id = z.uuid().safeParse(rawOrderId);
  if (!id.success) {
    return null;
  }
  const order = await findAdminOrder(db, id.data);
  return order ? { ...order, items: order.items.map((i) => ({ ...i, printFiles: parsePrintFiles(i.printFiles) })) } : null;
}
