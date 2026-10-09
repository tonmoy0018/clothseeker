import { randomInt } from "node:crypto";

import { z } from "zod";

import type { Actor } from "@/lib/auth/policy";
import type { CourierProvider } from "@/lib/couriers/types";
import type { PrismaClient } from "@/lib/db/client";
import { Prisma } from "@/lib/generated/prisma/client";
import type { ShipmentStatus } from "@/lib/generated/prisma/enums";
import { transitionItems } from "@/lib/orders/transitions";

import { moveItemAsAdmin } from "./move";

const TRACKING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** e.g. MCK7K3QX9A2BC — uniqueness is enforced by the database. */
export function generateTrackingNumber(random: (max: number) => number = randomInt): string {
  let code = "";
  for (let i = 0; i < 10; i += 1) {
    code += TRACKING_ALPHABET.charAt(random(TRACKING_ALPHABET.length));
  }
  return `MCK${code}`;
}

const shipSchema = z.object({ itemId: z.uuid() });

/** Books the (mock) courier for a ready item: creates its shipment and moves it to SHIPPED. */
export async function shipItem(db: PrismaClient, courier: CourierProvider, actor: Actor, rawInput: unknown, now: Date = new Date()): Promise<{ trackingNumber: string }> {
  const { itemId } = shipSchema.parse(rawInput);
  const trackingNumber = generateTrackingNumber();
  await moveItemAsAdmin(db, actor, itemId, "SHIPPED", {
    note: `Handed to ${courier.carrierLabel} · ${trackingNumber}`,
    auditAction: "order.item.ship",
    auditMetadata: { trackingNumber },
    extra: async (tx, item) => {
      await tx.shipment.create({
        data: { orderItemId: item.id, carrier: courier.carrierLabel, trackingNumber, status: "LABEL_CREATED", shippedAt: now },
      });
    },
  });
  return { trackingNumber };
}

export class CourierWebhookError extends Error {
  override readonly name = "CourierWebhookError";
}

const RANK: Record<ShipmentStatus, number> = { LABEL_CREATED: 0, IN_TRANSIT: 1, OUT_FOR_DELIVERY: 2, DELIVERED: 3 };
const STATUS: Record<"in_transit" | "out_for_delivery" | "delivered", ShipmentStatus> = {
  in_transit: "IN_TRANSIT",
  out_for_delivery: "OUT_FOR_DELIVERY",
  delivered: "DELIVERED",
};

export type CourierOutcome = "updated" | "delivered" | "duplicate" | "recorded";

/**
 * Courier status webhook. Idempotent per eventId; statuses only move forward (a late "in transit"
 * after "delivered" is recorded in the history but doesn't rewind the shipment).
 */
export async function handleCourierWebhook(
  db: PrismaClient,
  courier: CourierProvider,
  rawBody: string,
  headers: Headers,
  now: Date = new Date(),
): Promise<CourierOutcome> {
  const event = courier.parseWebhook(rawBody, headers);
  const shipment = await db.shipment.findUnique({
    where: { trackingNumber: event.trackingNumber },
    select: { id: true, status: true, orderItemId: true },
  });
  if (!shipment) {
    throw new CourierWebhookError("Unknown tracking number");
  }
  const status = STATUS[event.status];
  try {
    return await db.$transaction(async (tx) => {
      if (await tx.courierEvent.findUnique({ where: { eventId: event.eventId }, select: { id: true } })) {
        return "duplicate";
      }
      await tx.courierEvent.create({ data: { eventId: event.eventId, shipmentId: shipment.id, status, note: event.note ?? null } });
      if (RANK[status] <= RANK[shipment.status]) {
        return "recorded";
      }
      await tx.shipment.update({
        where: { id: shipment.id },
        data: { status, ...(status === "DELIVERED" ? { deliveredAt: now } : {}) },
      });
      if (status === "DELIVERED") {
        await transitionItems(tx, {
          itemIds: [shipment.orderItemId],
          to: "DELIVERED",
          actor: { type: "COURIER", id: null },
          note: event.note ?? "Delivered by the courier",
        });
        return "delivered";
      }
      return "updated";
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return "duplicate";
    }
    throw error;
  }
}
