import type { OrderItemStatus, OrderStatus } from "@/lib/generated/prisma/enums";

// Customer-facing wording for statuses (shared by server and client components).

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING_PAYMENT: "Awaiting payment",
  PAID: "Paid",
  CANCELLED: "Cancelled",
  REFUNDED: "Refunded",
};

export const ITEM_STATUS_LABEL: Record<OrderItemStatus, string> = {
  PENDING_PAYMENT: "Awaiting payment",
  PAID: "Paid",
  AWAITING_ACCEPTANCE: "Awaiting acceptance",
  ACCEPTED: "Accepted",
  IN_PRODUCTION: "In production",
  QC_SUBMITTED: "Quality check",
  READY_TO_SHIP: "Ready to ship",
  SHIPPED: "Shipped",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
  REFUNDED: "Refunded",
  DISPUTED: "Disputed",
};

const ALL_LABELS = new Map<string, string>([...Object.entries(ORDER_STATUS_LABEL), ...Object.entries(ITEM_STATUS_LABEL)]);

/** Label for any order or item status string (e.g. from the order timeline). */
export function statusLabel(status: string): string {
  return ALL_LABELS.get(status) ?? status;
}
