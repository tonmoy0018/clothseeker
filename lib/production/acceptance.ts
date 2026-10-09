import { z } from "zod";

import type { Actor } from "@/lib/auth/policy";
import type { PrismaClient } from "@/lib/db/client";
import { transitionItems } from "@/lib/orders/transitions";
import type { PaymentProvider } from "@/lib/payments/types";

import { ProductionError } from "./errors";
import { moveItemAsAdmin } from "./move";
import { planItemRefunds, settleRefunds } from "./refunds";

// Custom items wait in AWAITING_ACCEPTANCE for up to 24 hours. The team accepts or declines;
// declined or overdue items are refunded in full automatically (decision recorded in CLAUDE.md).

const itemIdSchema = z.uuid();
const declineSchema = z.object({ itemId: z.uuid(), reason: z.string().trim().min(3, "Give the customer a short reason").max(200) });

export async function acceptItem(db: PrismaClient, actor: Actor, rawItemId: unknown, now: Date = new Date()): Promise<void> {
  const itemId = itemIdSchema.parse(rawItemId);
  await moveItemAsAdmin(db, actor, itemId, "ACCEPTED", {
    note: "Accepted by ClothSeeker",
    auditAction: "order.item.accept",
    before: async (tx, item) => {
      const { acceptBy } = await tx.orderItem.findUniqueOrThrow({ where: { id: item.id }, select: { acceptBy: true } });
      if (acceptBy && acceptBy < now) {
        throw new ProductionError("DEADLINE_PASSED", "The 24-hour acceptance window has passed; this item is being refunded.");
      }
    },
  });
}

export async function declineItem(db: PrismaClient, provider: PaymentProvider, actor: Actor, rawInput: unknown): Promise<void> {
  const input = declineSchema.parse(rawInput);
  const item = await moveItemAsAdmin(db, actor, input.itemId, "REFUNDED", {
    note: `Declined: ${input.reason}`,
    auditAction: "order.item.decline",
    extra: (tx, it) => planItemRefunds(tx, { orderId: it.orderId, itemIds: [it.id], reason: `Declined by ClothSeeker: ${input.reason}` }),
  });
  await settleRefunds(db, provider, { orderId: item.orderId });
}

/**
 * SYSTEM sweep: refunds custom items nobody accepted within 24 hours. Idempotent (guarded moves,
 * unique refunds) — the worker runs it on every poll and the admin queue runs it on load.
 */
export async function expireOverdueAcceptances(db: PrismaClient, provider: PaymentProvider, now: Date): Promise<number> {
  const overdue = await db.orderItem.findMany({
    where: { status: "AWAITING_ACCEPTANCE", acceptBy: { lt: now } },
    orderBy: { acceptBy: "asc" },
    take: 50,
    select: { id: true, orderId: true },
  });
  let refunded = 0;
  for (const item of overdue) {
    const moved = await db.$transaction(async (tx) => {
      const ids = await transitionItems(tx, {
        itemIds: [item.id],
        to: "REFUNDED",
        actor: { type: "SYSTEM", id: null },
        note: "Not accepted within 24 hours — refunded in full",
      });
      if (ids.length > 0) {
        await planItemRefunds(tx, { orderId: item.orderId, itemIds: ids, reason: "Not accepted within 24 hours" });
      }
      return ids.length;
    });
    if (moved > 0) {
      refunded += moved;
      await settleRefunds(db, provider, { orderId: item.orderId });
    }
  }
  return refunded;
}
