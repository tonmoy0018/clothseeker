import { z } from "zod";

import { writeAudit } from "@/lib/admin/audit";
import { assertAdmin, type Actor } from "@/lib/auth/policy";
import type { PrismaClient } from "@/lib/db/client";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { QcSide } from "@/lib/generated/prisma/enums";
import { ImageValidationError, processImage } from "@/lib/media/process-image";
import type { StorageAdapter } from "@/lib/storage/adapter";
import { BUCKETS } from "@/lib/storage/buckets";
import { buildObjectKey } from "@/lib/storage/object-key";

import { ProductionError } from "./errors";
import { loadItem, moveItemAsAdmin } from "./move";

// Making and checking garments. Custom items: ACCEPTED → IN_PRODUCTION → (front + back QC photos)
// → QC_SUBMITTED → READY_TO_SHIP, or back to IN_PRODUCTION when QC fails. Ready-made: PAID → READY_TO_SHIP.

const itemIdSchema = z.uuid();

export function markReadyToShip(db: PrismaClient, actor: Actor, rawItemId: unknown) {
  return moveItemAsAdmin(db, actor, itemIdSchema.parse(rawItemId), "READY_TO_SHIP", {
    note: "Packed and ready to ship",
    auditAction: "order.item.ready",
  });
}

export function startProduction(db: PrismaClient, actor: Actor, rawItemId: unknown) {
  return moveItemAsAdmin(db, actor, itemIdSchema.parse(rawItemId), "IN_PRODUCTION", {
    note: "Production started",
    auditAction: "order.item.production",
  });
}

/** Both sides need a photo taken during the current production round. Pure. */
export function qcPhotosComplete(photos: readonly { side: QcSide; createdAt: Date }[], productionStartedAt: Date): boolean {
  const recent = photos.filter((p) => p.createdAt >= productionStartedAt);
  return recent.some((p) => p.side === "FRONT") && recent.some((p) => p.side === "BACK");
}

/** When the item last (re-)entered production — QC photos must be newer than this. */
async function productionStartedAt(db: Prisma.TransactionClient, itemId: string): Promise<Date> {
  const event = await db.orderEvent.findFirst({
    where: { orderItemId: itemId, toStatus: "IN_PRODUCTION" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return event?.createdAt ?? new Date(0);
}

export async function uploadQcPhoto(
  db: PrismaClient,
  storage: StorageAdapter,
  actor: Actor,
  rawInput: { itemId: unknown; side: unknown },
  bytes: Uint8Array,
): Promise<{ key: string }> {
  assertAdmin(actor);
  const itemId = itemIdSchema.parse(rawInput.itemId);
  const side = z.enum(["FRONT", "BACK"]).parse(rawInput.side);
  const item = await loadItem(db, itemId);
  if (item.status !== "IN_PRODUCTION") {
    throw new ProductionError("INVALID_STATE", "QC photos can be added while the item is in production.");
  }
  let image;
  try {
    image = await processImage(bytes, "productPhoto");
  } catch (error) {
    if (error instanceof ImageValidationError) {
      throw new ProductionError("INVALID", error.message);
    }
    throw error;
  }
  const key = buildObjectKey(BUCKETS.qcPhotos, { ownerId: item.orderId, category: "qc", extension: image.extension });
  await storage.put(BUCKETS.qcPhotos, key, image.data, image.contentType);
  try {
    await db.$transaction(async (tx) => {
      await tx.qcPhoto.create({ data: { orderItemId: item.id, side, storageKey: key, uploadedById: actor.id } });
      await writeAudit(tx, actor, "order.item.qc_photo", { type: "order_item", id: item.id }, { orderId: item.orderId, side });
    });
  } catch (error) {
    await storage.remove(BUCKETS.qcPhotos, [key]).catch(() => undefined);
    throw error;
  }
  return { key };
}

export function submitQc(db: PrismaClient, actor: Actor, rawItemId: unknown) {
  return moveItemAsAdmin(db, actor, itemIdSchema.parse(rawItemId), "QC_SUBMITTED", {
    note: "Submitted for quality check",
    auditAction: "order.item.qc_submit",
    before: async (tx, item) => {
      const since = await productionStartedAt(tx, item.id);
      const photos = await tx.qcPhoto.findMany({ where: { orderItemId: item.id }, select: { side: true, createdAt: true } });
      if (!qcPhotosComplete(photos, since)) {
        throw new ProductionError("QC_INCOMPLETE", "Upload a front and a back QC photo of the finished garment first.");
      }
    },
  });
}

export function approveQc(db: PrismaClient, actor: Actor, rawItemId: unknown) {
  return moveItemAsAdmin(db, actor, itemIdSchema.parse(rawItemId), "READY_TO_SHIP", {
    note: "Quality check passed",
    auditAction: "order.item.qc_approve",
  });
}

const rejectSchema = z.object({ itemId: z.uuid(), note: z.string().trim().min(3, "Say what needs fixing").max(300) });

export function rejectQc(db: PrismaClient, actor: Actor, rawInput: unknown) {
  const input = rejectSchema.parse(rawInput);
  return moveItemAsAdmin(db, actor, input.itemId, "IN_PRODUCTION", {
    note: `Quality check failed: ${input.note}`,
    auditAction: "order.item.qc_reject",
  });
}
