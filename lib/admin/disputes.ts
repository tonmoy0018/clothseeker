import { z } from "zod";

import { assertAdmin, type Actor } from "@/lib/auth/policy";
import type { PrismaClient } from "@/lib/db/client";
import type { DisputeStatus, ItemKind, OrderItemStatus, ShipmentStatus } from "@/lib/generated/prisma/enums";
import { parsePrintFiles } from "@/lib/orders/print-files";
import type { PaymentProvider } from "@/lib/payments/types";
import { moveItemAsAdmin } from "@/lib/production/move";
import { planItemRefunds, settleRefunds } from "@/lib/production/refunds";
import type { StorageAdapter } from "@/lib/storage/adapter";
import { BUCKETS } from "@/lib/storage/buckets";
import { isSafeObjectKey } from "@/lib/storage/object-key";

import { AdminError } from "./errors";

// The team's side of disputes. The evidence view shows only what's needed to decide: the approved
// design and print files, QC photos, the customer's photos and reason, and the item's timeline.
// No address or phone. Resolving goes through moveItemAsAdmin (state machine + audit).

export const DISPUTE_TABS = ["open", "resolved"] as const;
export type DisputeTab = (typeof DISPUTE_TABS)[number];

export type DisputeRow = {
  id: string;
  status: DisputeStatus;
  reason: string;
  createdAt: Date;
  orderId: string;
  orderNumber: string;
  productName: string;
  kind: ItemKind;
  amountMinor: number;
};

export async function listDisputes(db: PrismaClient, actor: Actor, rawTab: unknown): Promise<DisputeRow[]> {
  assertAdmin(actor);
  const tab = z.enum(DISPUTE_TABS).catch("open").parse(rawTab);
  const rows = await db.dispute.findMany({
    where: tab === "open" ? { status: "OPEN" } : { status: { not: "OPEN" } },
    orderBy: tab === "open" ? { createdAt: "asc" } : { resolvedAt: "desc" },
    take: 100,
    select: {
      id: true,
      status: true,
      reason: true,
      createdAt: true,
      orderItem: { select: { orderId: true, productName: true, kind: true, unitPriceMinor: true, quantity: true, order: { select: { number: true } } } },
    },
  });
  return rows.map((d) => ({
    id: d.id,
    status: d.status,
    reason: d.reason,
    createdAt: d.createdAt,
    orderId: d.orderItem.orderId,
    orderNumber: d.orderItem.order.number,
    productName: d.orderItem.productName,
    kind: d.orderItem.kind,
    amountMinor: d.orderItem.unitPriceMinor * d.orderItem.quantity,
  }));
}

export async function countOpenDisputes(db: PrismaClient, actor: Actor): Promise<number> {
  assertAdmin(actor);
  return db.dispute.count({ where: { status: "OPEN" } });
}

export type DisputeEvidence = {
  id: string;
  status: DisputeStatus;
  reason: string;
  resolution: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  customerPhotoUrls: string[];
  item: {
    id: string;
    orderId: string;
    orderNumber: string;
    kind: ItemKind;
    status: OrderItemStatus;
    productName: string;
    size: string;
    colorName: string | null;
    quantity: number;
    amountMinor: number;
    previewUrl: string | null;
    printFiles: { label: string; url: string | null }[];
    qcPhotos: { side: string; url: string | null; createdAt: Date }[];
  };
  timeline: { at: Date; status: string; actor: string; note: string | null }[];
  courier: { at: Date; status: ShipmentStatus; note: string | null }[];
};

export async function getDisputeEvidence(db: PrismaClient, storage: StorageAdapter, actor: Actor, rawId: unknown): Promise<DisputeEvidence | null> {
  assertAdmin(actor);
  const id = z.uuid().safeParse(rawId);
  const d = id.success
    ? await db.dispute.findUnique({
        where: { id: id.data },
        select: {
          id: true,
          status: true,
          reason: true,
          resolution: true,
          createdAt: true,
          resolvedAt: true,
          photoKeys: true,
          orderItem: {
            select: {
              id: true,
              orderId: true,
              kind: true,
              status: true,
              productName: true,
              size: true,
              colorName: true,
              quantity: true,
              unitPriceMinor: true,
              previewKey: true,
              printFiles: true,
              order: { select: { number: true } },
              qcPhotos: { orderBy: { createdAt: "asc" }, select: { side: true, storageKey: true, createdAt: true } },
              events: { orderBy: { createdAt: "asc" }, select: { createdAt: true, toStatus: true, actorType: true, note: true } },
              shipment: { select: { courierEvents: { orderBy: { createdAt: "asc" }, select: { createdAt: true, status: true, note: true } } } },
            },
          },
        },
      })
    : null;
  if (!d) {
    return null;
  }
  const item = d.orderItem;
  const printFiles = parsePrintFiles(item.printFiles);
  const designKeys = [...d.photoKeys, item.previewKey, ...printFiles.map((f) => f.key)].filter((k): k is string => typeof k === "string" && isSafeObjectKey(k));
  const [designUrls, qcUrls] = await Promise.all([
    storage.signReadUrls(BUCKETS.designAssets, designKeys),
    storage.signReadUrls(BUCKETS.qcPhotos, item.qcPhotos.map((q) => q.storageKey).filter(isSafeObjectKey)),
  ]);
  return {
    id: d.id,
    status: d.status,
    reason: d.reason,
    resolution: d.resolution,
    createdAt: d.createdAt,
    resolvedAt: d.resolvedAt,
    customerPhotoUrls: d.photoKeys.flatMap((k) => {
      const url = designUrls.get(k);
      return url ? [url] : [];
    }),
    item: {
      id: item.id,
      orderId: item.orderId,
      orderNumber: item.order.number,
      kind: item.kind,
      status: item.status,
      productName: item.productName,
      size: item.size,
      colorName: item.colorName,
      quantity: item.quantity,
      amountMinor: item.unitPriceMinor * item.quantity,
      previewUrl: item.previewKey ? (designUrls.get(item.previewKey) ?? null) : null,
      printFiles: printFiles.map((f) => ({ label: f.label, url: designUrls.get(f.key) ?? null })),
      qcPhotos: item.qcPhotos.map((q) => ({ side: q.side, url: qcUrls.get(q.storageKey) ?? null, createdAt: q.createdAt })),
    },
    timeline: item.events.map((e) => ({ at: e.createdAt, status: e.toStatus, actor: e.actorType, note: e.note })),
    courier: item.shipment?.courierEvents.map((e) => ({ at: e.createdAt, status: e.status, note: e.note })) ?? [],
  };
}

export const resolveDisputeSchema = z.object({
  disputeId: z.uuid(),
  outcome: z.enum(["refund", "reject"]),
  note: z.string().trim().min(5, "Write a short note for the customer.").max(1000, "Keep the note under 1000 characters."),
});

/** Refund the item (DISPUTED → REFUNDED) or keep the delivery (DISPUTED → DELIVERED). Once only; audited. */
export async function resolveDispute(db: PrismaClient, provider: PaymentProvider, actor: Actor, rawInput: unknown, now: Date = new Date()): Promise<void> {
  assertAdmin(actor);
  const parsed = resolveDisputeSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AdminError("INVALID", parsed.error.issues[0]?.message ?? "Please check the form.");
  }
  const input = parsed.data;
  const dispute = await db.dispute.findUnique({ where: { id: input.disputeId }, select: { id: true, status: true, orderItemId: true } });
  if (!dispute) {
    throw new AdminError("NOT_FOUND", "That dispute doesn't exist.");
  }
  if (dispute.status !== "OPEN") {
    throw new AdminError("CONFLICT", "This dispute has already been resolved.");
  }
  const refund = input.outcome === "refund";
  const item = await moveItemAsAdmin(db, actor, dispute.orderItemId, refund ? "REFUNDED" : "DELIVERED", {
    note: refund ? `Dispute resolved with a refund: ${input.note}` : `Dispute closed without a refund: ${input.note}`,
    auditAction: refund ? "dispute.refunded" : "dispute.rejected",
    auditMetadata: { disputeId: dispute.id },
    extra: async (tx, it) => {
      const closed = await tx.dispute.updateMany({
        where: { id: dispute.id, status: "OPEN" },
        data: { status: refund ? "RESOLVED_REFUND" : "RESOLVED_REJECTED", resolution: input.note, resolvedAt: now },
      });
      if (closed.count !== 1) {
        throw new AdminError("CONFLICT", "This dispute has already been resolved.");
      }
      if (refund) {
        await planItemRefunds(tx, { orderId: it.orderId, itemIds: [it.id], reason: `Problem reported after delivery: ${input.note}` });
      }
    },
  });
  if (refund) {
    await settleRefunds(db, provider, { orderId: item.orderId });
  }
}
