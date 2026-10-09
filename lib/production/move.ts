import { writeAudit, type AuditMetadata } from "@/lib/admin/audit";
import { assertAdmin, type Actor } from "@/lib/auth/policy";
import type { PrismaClient } from "@/lib/db/client";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { OrderItemStatus } from "@/lib/generated/prisma/enums";
import { IllegalTransitionError, transitionItems } from "@/lib/orders/transitions";
import { ITEM_STATUS_LABEL } from "@/lib/orders/labels";

import { ProductionError } from "./errors";

export type ItemRef = { id: string; orderId: string; kind: string; status: OrderItemStatus };

export async function loadItem(db: PrismaClient | Prisma.TransactionClient, itemId: string): Promise<ItemRef> {
  const item = await db.orderItem.findUnique({ where: { id: itemId }, select: { id: true, orderId: true, kind: true, status: true } });
  if (!item) {
    throw new ProductionError("NOT_FOUND", "That order item no longer exists.");
  }
  return item;
}

/**
 * The one way the team moves an item: admin check, state machine, audit — in one transaction.
 * `extra` runs inside the same transaction after the move (e.g. create a shipment, plan refunds).
 */
export async function moveItemAsAdmin(
  db: PrismaClient,
  actor: Actor,
  itemId: string,
  to: OrderItemStatus,
  options: {
    note?: string;
    auditAction: string;
    auditMetadata?: AuditMetadata;
    data?: Prisma.OrderItemUpdateManyMutationInput;
    before?: (tx: Prisma.TransactionClient, item: ItemRef) => Promise<void>;
    extra?: (tx: Prisma.TransactionClient, item: ItemRef) => Promise<void>;
  },
): Promise<ItemRef> {
  assertAdmin(actor);
  try {
    return await db.$transaction(async (tx) => {
      const item = await loadItem(tx, itemId);
      await options.before?.(tx, item);
      const moved = await transitionItems(tx, { itemIds: [item.id], to, actor: { type: "ADMIN", id: actor.id }, note: options.note, data: options.data });
      if (moved.length === 0) {
        throw new ProductionError("INVALID_STATE", `This item is already ${ITEM_STATUS_LABEL[to].toLowerCase()}.`);
      }
      await options.extra?.(tx, item);
      await writeAudit(tx, actor, options.auditAction, { type: "order_item", id: item.id }, { orderId: item.orderId, to, ...options.auditMetadata });
      return item;
    });
  } catch (error) {
    if (error instanceof IllegalTransitionError) {
      throw new ProductionError("INVALID_STATE", "This item can't do that in its current state. Refresh the page to see its latest status.");
    }
    throw error;
  }
}
