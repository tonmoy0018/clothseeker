import type { Prisma } from "@/lib/generated/prisma/client";
import type { ItemKind, NotificationKind, OrderItemStatus } from "@/lib/generated/prisma/enums";

import { itemNotificationKind, itemsUniqueKey } from "./rules";

// The email outbox. Emails are queued INSIDE the transaction of the event that causes them, so
// they're never lost (the event committed) or sent for an event that rolled back. The worker sends
// them (sender.ts). Duplicates are ignored through `uniqueKey`.

export type NotificationPayload = { orderId?: string; itemIds?: string[]; quoteId?: string };

export async function notify(
  tx: Prisma.TransactionClient,
  input: { customerId: string; kind: NotificationKind; uniqueKey: string; payload: NotificationPayload },
): Promise<void> {
  await tx.notification.createMany({ data: [input], skipDuplicates: true });
}

export type MovedItem = { id: string; orderId: string; kind: ItemKind; from: OrderItemStatus };

/** Queues the emails for items that just moved to `to` (one per order and kind). */
export async function notifyItemMoves(tx: Prisma.TransactionClient, moved: readonly MovedItem[], to: OrderItemStatus): Promise<void> {
  const groups = new Map<string, { orderId: string; kind: NotificationKind; itemIds: string[] }>();
  for (const item of moved) {
    const kind = itemNotificationKind({ kind: item.kind, from: item.from, to });
    if (!kind) continue;
    const key = `${item.orderId}:${kind}`;
    const group = groups.get(key) ?? { orderId: item.orderId, kind, itemIds: [] };
    group.itemIds.push(item.id);
    groups.set(key, group);
  }
  if (groups.size === 0) {
    return;
  }
  const orders = await tx.order.findMany({ where: { id: { in: [...new Set([...groups.values()].map((g) => g.orderId))] } }, select: { id: true, customerId: true } });
  for (const group of groups.values()) {
    const customerId = orders.find((o) => o.id === group.orderId)?.customerId;
    if (!customerId) continue;
    await notify(tx, {
      customerId,
      kind: group.kind,
      uniqueKey: itemsUniqueKey(group.kind, group.orderId, group.itemIds),
      payload: { orderId: group.orderId, itemIds: group.itemIds },
    });
  }
}
