import type { PrismaClient } from "@/lib/db/client";
import type { StorageAdapter } from "@/lib/storage/adapter";

import { cancelPendingOrder, removeOrderFiles } from "./cancel";

/**
 * Cancels PENDING_PAYMENT orders whose payment window has passed, returning their stock.
 * Idempotent and safe to run concurrently (each cancel is guarded). Run by the worker on every poll,
 * and at checkout for the customer's own orders. Returns how many orders were cancelled.
 */
export async function expireStalePendingOrders(
  db: PrismaClient,
  storage: StorageAdapter | undefined,
  now: Date,
  options: { customerId?: string; limit?: number } = {},
): Promise<number> {
  const stale = await db.order.findMany({
    where: { status: "PENDING_PAYMENT", expiresAt: { lt: now }, ...(options.customerId ? { customerId: options.customerId } : {}) },
    orderBy: { expiresAt: "asc" },
    take: options.limit ?? 50,
    select: { id: true },
  });
  let cancelled = 0;
  for (const order of stale) {
    const result = await db.$transaction((tx) =>
      cancelPendingOrder(tx, order.id, { type: "SYSTEM", id: null }, "Payment window expired"),
    );
    if (result.cancelled) {
      cancelled += 1;
      await removeOrderFiles(storage, result.fileKeys);
    }
  }
  return cancelled;
}
