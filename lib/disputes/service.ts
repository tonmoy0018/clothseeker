import { z } from "zod";

import { writeAudit } from "@/lib/admin/audit";
import { assertCustomer, type Actor } from "@/lib/auth/policy";
import type { PrismaClient } from "@/lib/db/client";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { DisputeStatus } from "@/lib/generated/prisma/enums";
import { ImageValidationError, processImage } from "@/lib/media/process-image";
import { transitionItems } from "@/lib/orders/transitions";
import type { StorageAdapter } from "@/lib/storage/adapter";
import { BUCKETS } from "@/lib/storage/buckets";
import { buildObjectKey } from "@/lib/storage/object-key";

import { disputeDeadline, disputeIneligibility, MAX_DISPUTE_PHOTOS } from "./rules";

// "Report a problem" with a delivered item (customer side). Owner-scoped; the item moves
// DELIVERED → DISPUTED in the same transaction that records the dispute.

export type DisputeErrorCode = "INVALID" | "NOT_FOUND" | "NOT_ELIGIBLE" | "UPLOAD_INVALID";

export class DisputeError extends Error {
  override readonly name = "DisputeError";

  constructor(
    readonly code: DisputeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const openSchema = z.object({
  itemId: z.uuid(),
  reason: z
    .string()
    .trim()
    .min(20, "Tell us what's wrong in a sentence or two.")
    .max(1000, "Keep it under 1000 characters."),
});

/** When an item was delivered: its latest DELIVERED event. */
export async function deliveredAt(db: PrismaClient | Prisma.TransactionClient, itemId: string): Promise<Date | null> {
  const event = await db.orderEvent.findFirst({ where: { orderItemId: itemId, toStatus: "DELIVERED" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  return event?.createdAt ?? null;
}

export async function openDispute(
  db: PrismaClient,
  storage: StorageAdapter,
  actor: Actor,
  input: { itemId: unknown; reason: unknown; photos: readonly Uint8Array[] },
  now: Date = new Date(),
): Promise<{ disputeId: string }> {
  assertCustomer(actor);
  const parsed = openSchema.safeParse(input);
  if (!parsed.success) {
    throw new DisputeError("INVALID", parsed.error.issues[0]?.message ?? "Please check the form.");
  }
  if (input.photos.length > MAX_DISPUTE_PHOTOS) {
    throw new DisputeError("INVALID", `Add up to ${MAX_DISPUTE_PHOTOS} photos.`);
  }
  const item = await db.orderItem.findFirst({
    where: { id: parsed.data.itemId, order: { customerId: actor.id } },
    select: { id: true, orderId: true, status: true, _count: { select: { disputes: true } } },
  });
  if (!item) {
    throw new DisputeError("NOT_FOUND", "That item isn't in one of your orders.");
  }
  const problem = disputeIneligibility({ status: item.status, deliveredAt: await deliveredAt(db, item.id), earlierDisputes: item._count.disputes }, now);
  if (problem) {
    throw new DisputeError("NOT_ELIGIBLE", problem);
  }

  // Photos are checked and stored before the transaction; removed again if it fails.
  const keys: string[] = [];
  const cleanup = () => storage.remove(BUCKETS.designAssets, keys).catch(() => undefined);
  try {
    for (const bytes of input.photos) {
      const image = await processImage(bytes, "aiInput");
      const key = buildObjectKey(BUCKETS.designAssets, { ownerId: actor.id, category: "disputes", extension: image.extension });
      await storage.put(BUCKETS.designAssets, key, image.data, image.contentType);
      keys.push(key);
    }
  } catch (error) {
    await cleanup();
    if (error instanceof ImageValidationError) {
      throw new DisputeError("UPLOAD_INVALID", error.message);
    }
    throw error;
  }

  try {
    return await db.$transaction(async (tx) => {
      const moved = await transitionItems(tx, { itemIds: [item.id], to: "DISPUTED", actor: { type: "CUSTOMER", id: actor.id }, note: "Problem reported by the customer" });
      if (moved.length !== 1) {
        throw new DisputeError("NOT_ELIGIBLE", "You can report a problem once the item has been delivered.");
      }
      const dispute = await tx.dispute.create({
        data: { orderItemId: item.id, customerId: actor.id, reason: parsed.data.reason, photoKeys: keys, createdAt: now },
        select: { id: true },
      });
      await writeAudit(tx, actor, "dispute.opened", { type: "dispute", id: dispute.id }, { orderItemId: item.id, orderId: item.orderId, photos: keys.length });
      return { disputeId: dispute.id };
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export type CustomerDisputeView = { itemId: string; status: DisputeStatus; reason: string; resolution: string | null; createdAt: Date };
export type DisputeOption = { itemId: string; deadline: Date };

/** For the order page: existing disputes per item, and which items can still be reported (with the deadline). */
export async function disputeInfoForOrder(db: PrismaClient, actor: Actor, orderId: string, now: Date = new Date()): Promise<{ disputes: CustomerDisputeView[]; reportable: DisputeOption[] }> {
  const items = await db.orderItem.findMany({
    where: { orderId, order: { customerId: actor.id } },
    select: {
      id: true,
      status: true,
      disputes: { orderBy: { createdAt: "desc" }, select: { status: true, reason: true, resolution: true, createdAt: true } },
    },
  });
  const disputes: CustomerDisputeView[] = [];
  const reportable: DisputeOption[] = [];
  for (const item of items) {
    for (const d of item.disputes) {
      disputes.push({ itemId: item.id, ...d });
    }
    if (item.status === "DELIVERED") {
      const at = await deliveredAt(db, item.id);
      if (at && !disputeIneligibility({ status: item.status, deliveredAt: at, earlierDisputes: item.disputes.length }, now)) {
        reportable.push({ itemId: item.id, deadline: disputeDeadline(at) });
      }
    }
  }
  return { disputes, reportable };
}
