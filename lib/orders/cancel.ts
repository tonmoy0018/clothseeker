import type { Prisma } from "@/lib/generated/prisma/client";
import type { StorageAdapter } from "@/lib/storage/adapter";
import { BUCKETS } from "@/lib/storage/buckets";

import { printFileKeys } from "./print-files";
import { transitionItems, type TransitionActor } from "./transitions";

/**
 * Cancels a PENDING_PAYMENT order inside the caller's transaction: returns reserved stock, cancels
 * every item through the state machine, records the event. Guarded, so it runs at most once.
 * Returns the storage keys rendered for the order, to delete after the transaction commits.
 */
export async function cancelPendingOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
  actor: TransitionActor,
  note: string,
): Promise<{ cancelled: boolean; fileKeys: string[] }> {
  const updated = await tx.order.updateMany({ where: { id: orderId, status: "PENDING_PAYMENT" }, data: { status: "CANCELLED" } });
  if (updated.count !== 1) {
    return { cancelled: false, fileKeys: [] };
  }
  const items = await tx.orderItem.findMany({
    where: { orderId },
    select: { id: true, variantId: true, quantity: true, kind: true, previewKey: true, printFiles: true },
  });
  for (const item of items) {
    if (item.kind === "READY_MADE" && item.variantId) {
      await tx.variant.update({ where: { id: item.variantId }, data: { stock: { increment: item.quantity } } });
    }
  }
  await transitionItems(tx, { itemIds: items.map((i) => i.id), to: "CANCELLED", actor, note });
  await tx.payment.updateMany({ where: { orderId, status: "PENDING" }, data: { status: "FAILED" } });
  await tx.orderEvent.create({
    data: { orderId, fromStatus: "PENDING_PAYMENT", toStatus: "CANCELLED", actorType: actor.type, actorId: actor.id, note },
  });
  const fileKeys = items.flatMap((i) => [...(i.previewKey ? [i.previewKey] : []), ...printFileKeys(i.printFiles)]);
  return { cancelled: true, fileKeys };
}

/** Best-effort removal of files rendered for an order that will never be produced. */
export async function removeOrderFiles(storage: StorageAdapter | undefined, keys: readonly string[]): Promise<void> {
  if (storage && keys.length > 0) {
    await storage.remove(BUCKETS.designAssets, keys).catch(() => undefined);
  }
}
