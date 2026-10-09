import type { ItemKind, NotificationKind, OrderItemStatus } from "@/lib/generated/prisma/enums";

// Which order-item moves email the customer (pure, unit tested). Order confirmation and quote
// emails are queued where those events happen (payments webhook, lib/admin/quotes, expiry).

export function itemNotificationKind(move: { kind: ItemKind; from: OrderItemStatus; to: OrderItemStatus }): NotificationKind | null {
  switch (move.to) {
    case "ACCEPTED":
      // Quotes are accepted automatically at payment; the order confirmation covers them.
      return move.kind === "CUSTOM_DESIGN" && move.from === "AWAITING_ACCEPTANCE" ? "DESIGN_ACCEPTED" : null;
    case "REFUNDED":
      return move.from === "DISPUTED" ? "DISPUTE_REFUNDED" : "ITEM_REFUNDED";
    case "SHIPPED":
      return "SHIPPED";
    case "DELIVERED":
      return move.from === "DISPUTED" ? "DISPUTE_CLOSED" : "DELIVERED";
    default:
      return null;
  }
}

/** One email per event: the same items moving to the same kind never email twice. */
export function itemsUniqueKey(kind: NotificationKind, orderId: string, itemIds: readonly string[]): string {
  return `${kind}:${orderId}:${[...itemIds].sort().join(",")}`;
}
