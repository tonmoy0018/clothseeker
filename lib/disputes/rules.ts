import type { OrderItemStatus } from "@/lib/generated/prisma/enums";

// Pure dispute rules (unit tested). A customer can report a problem with a delivered item for a
// limited time; the team then refunds it or explains why not (lib/admin/disputes.ts).

/** How long after delivery a problem can be reported. A default; change it here. */
export const DISPUTE_WINDOW_DAYS = 14;
export const DISPUTE_WINDOW_MS = DISPUTE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
export const MAX_DISPUTE_PHOTOS = 3;

export type DisputeEligibilityInput = {
  status: OrderItemStatus;
  /** When the item was delivered (its DELIVERED event), or null. */
  deliveredAt: Date | null;
  /** Disputes already opened for this item (any outcome). */
  earlierDisputes: number;
};

/** Null when the customer may report a problem, otherwise why not (shown to them). */
export function disputeIneligibility(input: DisputeEligibilityInput, now: Date): string | null {
  if (input.status !== "DELIVERED" || !input.deliveredAt) {
    return "You can report a problem once the item has been delivered.";
  }
  if (input.earlierDisputes > 0) {
    return "You've already reported a problem with this item.";
  }
  if (now.getTime() - input.deliveredAt.getTime() > DISPUTE_WINDOW_MS) {
    return `Problems can be reported within ${DISPUTE_WINDOW_DAYS} days of delivery.`;
  }
  return null;
}

/** Last day a problem can still be reported. */
export function disputeDeadline(deliveredAt: Date): Date {
  return new Date(deliveredAt.getTime() + DISPUTE_WINDOW_MS);
}
