import type { Prisma } from "@/lib/generated/prisma/client";
import type { ActorType, ItemKind, OrderItemStatus } from "@/lib/generated/prisma/enums";
import { notifyItemMoves, type MovedItem } from "@/lib/notifications/outbox";

// THE order-item state machine. Every status change of an order item goes through
// transitionItems(); nothing else may write OrderItem.status.
//
// Each edge lists who may take it: SYSTEM (payments, timeouts), ADMIN (the ClothSeeker team),
// COURIER (delivery updates), CUSTOMER (disputes).

type Edge = { to: OrderItemStatus; actors: readonly ActorType[] };
type Machine = Partial<Record<OrderItemStatus, readonly Edge[]>>;

const SYS = ["SYSTEM"] as const;
const ADMIN = ["ADMIN"] as const;

/** Shared tail once an item is ready to ship. */
const SHIPPING: Machine = {
  READY_TO_SHIP: [{ to: "SHIPPED", actors: ADMIN }],
  SHIPPED: [{ to: "DELIVERED", actors: ["COURIER", "ADMIN"] }],
  DELIVERED: [{ to: "DISPUTED", actors: ["CUSTOMER"] }],
  DISPUTED: [
    { to: "REFUNDED", actors: ADMIN },
    { to: "DELIVERED", actors: ADMIN },
  ],
};

/** Made-to-order production, shared by custom designs and accepted quotes. */
const PRODUCTION: Machine = {
  ACCEPTED: [{ to: "IN_PRODUCTION", actors: ADMIN }],
  IN_PRODUCTION: [{ to: "QC_SUBMITTED", actors: ADMIN }],
  QC_SUBMITTED: [
    { to: "READY_TO_SHIP", actors: ADMIN },
    { to: "IN_PRODUCTION", actors: ADMIN }, // QC failed: back to production
  ],
  ...SHIPPING,
};

const PAYMENT: Machine = {
  PENDING_PAYMENT: [
    { to: "PAID", actors: SYS },
    { to: "CANCELLED", actors: SYS },
  ],
};

export const TRANSITIONS: Record<ItemKind, Machine> = {
  READY_MADE: {
    ...PAYMENT,
    PAID: [
      { to: "READY_TO_SHIP", actors: ADMIN },
      { to: "REFUNDED", actors: ADMIN },
    ],
    ...SHIPPING,
  },
  CUSTOM_DESIGN: {
    ...PAYMENT,
    PAID: [{ to: "AWAITING_ACCEPTANCE", actors: SYS }],
    AWAITING_ACCEPTANCE: [
      { to: "ACCEPTED", actors: ADMIN },
      { to: "REFUNDED", actors: ["ADMIN", "SYSTEM"] }, // declined by the team, or 24 h timeout
    ],
    ...PRODUCTION,
  },
  QUOTE: {
    ...PAYMENT,
    PAID: [{ to: "ACCEPTED", actors: SYS }], // the price was agreed before payment
    ...PRODUCTION,
  },
};

/** The happy path per kind, for progress steppers. */
export const HAPPY_PATH: Record<ItemKind, readonly OrderItemStatus[]> = {
  READY_MADE: ["PENDING_PAYMENT", "PAID", "READY_TO_SHIP", "SHIPPED", "DELIVERED"],
  CUSTOM_DESIGN: ["PENDING_PAYMENT", "PAID", "AWAITING_ACCEPTANCE", "ACCEPTED", "IN_PRODUCTION", "QC_SUBMITTED", "READY_TO_SHIP", "SHIPPED", "DELIVERED"],
  QUOTE: ["PENDING_PAYMENT", "PAID", "ACCEPTED", "IN_PRODUCTION", "QC_SUBMITTED", "READY_TO_SHIP", "SHIPPED", "DELIVERED"],
};

export function canTransition(kind: ItemKind, from: OrderItemStatus, to: OrderItemStatus, actor: ActorType): boolean {
  return (TRANSITIONS[kind][from] ?? []).some((edge) => edge.to === to && edge.actors.includes(actor));
}

export class IllegalTransitionError extends Error {
  override readonly name = "IllegalTransitionError";

  constructor(kind: ItemKind, from: OrderItemStatus, to: OrderItemStatus, actor: ActorType) {
    super(`${actor} can't move a ${kind} item from ${from} to ${to}`);
  }
}

export type TransitionActor = { type: ActorType; id: string | null };

export type TransitionRequest = {
  itemIds: readonly string[];
  to: OrderItemStatus;
  actor: TransitionActor;
  note?: string;
  /** Extra fields to set with the status change (e.g. acceptBy). */
  data?: Prisma.OrderItemUpdateManyMutationInput;
};

/**
 * Moves items to `to` inside the caller's transaction. Each update is guarded by the current status,
 * so concurrent callers can't move an item twice. Items already in `to` are skipped (idempotent).
 * Returns the ids actually moved. Throws IllegalTransitionError for any illegal move.
 */
export async function transitionItems(tx: Prisma.TransactionClient, request: TransitionRequest): Promise<string[]> {
  const items = await tx.orderItem.findMany({
    where: { id: { in: [...request.itemIds] } },
    select: { id: true, orderId: true, kind: true, status: true },
  });
  const moved: string[] = [];
  const movedItems: MovedItem[] = [];
  for (const item of items) {
    if (item.status === request.to) {
      continue;
    }
    if (!canTransition(item.kind, item.status, request.to, request.actor.type)) {
      throw new IllegalTransitionError(item.kind, item.status, request.to, request.actor.type);
    }
    const updated = await tx.orderItem.updateMany({
      where: { id: item.id, status: item.status },
      data: { ...request.data, status: request.to },
    });
    if (updated.count === 1) {
      moved.push(item.id);
      movedItems.push({ id: item.id, orderId: item.orderId, kind: item.kind, from: item.status });
      await tx.orderEvent.create({
        data: {
          orderId: item.orderId,
          orderItemId: item.id,
          fromStatus: item.status,
          toStatus: request.to,
          actorType: request.actor.type,
          actorId: request.actor.id,
          note: request.note ?? null,
        },
      });
    }
  }
  // Customer emails for the moves that warrant one (lib/notifications/rules.ts), same transaction.
  await notifyItemMoves(tx, movedItems, request.to);
  return moved;
}
