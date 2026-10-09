import { z } from "zod";

import { assertAdmin, type Actor } from "@/lib/auth/policy";
import type { PrismaClient } from "@/lib/db/client";
import type { AIJobType, FlagStatus } from "@/lib/generated/prisma/enums";
import type { StorageAdapter } from "@/lib/storage/adapter";
import { BUCKETS } from "@/lib/storage/buckets";
import { isSafeObjectKey } from "@/lib/storage/object-key";

import { writeAudit } from "./audit";
import { AdminError } from "./errors";

// Brand-logo flags raised by the AI pipelines (a photo the planner judged to carry a clothing
// brand's logo). The team confirms them (the photo is deleted) or dismisses them as false alarms.

export const FLAG_TABS = ["open", "closed"] as const;

export type FlagRow = {
  id: string;
  status: FlagStatus;
  reason: string;
  createdAt: Date;
  reviewedAt: Date | null;
  reviewNote: string | null;
  imageUrl: string | null;
  /** Short, non-identifying reference to spot repeat cases. */
  customerRef: string | null;
  jobType: AIJobType | null;
};

export async function listFlags(db: PrismaClient, storage: StorageAdapter, actor: Actor, rawTab: unknown): Promise<FlagRow[]> {
  assertAdmin(actor);
  const tab = z.enum(FLAG_TABS).catch("open").parse(rawTab);
  const flags = await db.flaggedItem.findMany({
    where: tab === "open" ? { status: "OPEN" } : { status: { not: "OPEN" } },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, status: true, reason: true, createdAt: true, reviewedAt: true, reviewNote: true, storageKey: true, customerId: true, aiJobId: true },
  });
  const jobIds = flags.flatMap((f) => (f.aiJobId ? [f.aiJobId] : []));
  const jobs = jobIds.length > 0 ? await db.aIJob.findMany({ where: { id: { in: jobIds } }, select: { id: true, type: true } }) : [];
  const urls = await storage.signReadUrls(BUCKETS.designAssets, flags.flatMap((f) => (f.storageKey && isSafeObjectKey(f.storageKey) ? [f.storageKey] : [])));
  return flags.map((f) => ({
    id: f.id,
    status: f.status,
    reason: f.reason,
    createdAt: f.createdAt,
    reviewedAt: f.reviewedAt,
    reviewNote: f.reviewNote,
    imageUrl: f.storageKey ? (urls.get(f.storageKey) ?? null) : null,
    customerRef: f.customerId ? f.customerId.slice(0, 8) : null,
    jobType: jobs.find((j) => j.id === f.aiJobId)?.type ?? null,
  }));
}

export async function countOpenFlags(db: PrismaClient, actor: Actor): Promise<number> {
  assertAdmin(actor);
  return db.flaggedItem.count({ where: { status: "OPEN" } });
}

export const reviewFlagSchema = z.object({
  flagId: z.uuid(),
  decision: z.enum(["confirm", "dismiss"]),
  note: z.string().trim().max(500, "Keep the note under 500 characters.").optional().default(""),
});

/** Confirm (it is a brand logo: the photo is deleted) or dismiss (false alarm). Once only; audited. */
export async function reviewFlag(db: PrismaClient, storage: StorageAdapter, actor: Actor, rawInput: unknown, now: Date = new Date()): Promise<void> {
  assertAdmin(actor);
  const parsed = reviewFlagSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AdminError("INVALID", parsed.error.issues[0]?.message ?? "Please check the form.");
  }
  const input = parsed.data;
  const flag = await db.flaggedItem.findUnique({ where: { id: input.flagId }, select: { id: true, status: true, storageKey: true } });
  if (!flag) {
    throw new AdminError("NOT_FOUND", "That flag doesn't exist.");
  }
  const confirm = input.decision === "confirm";
  await db.$transaction(async (tx) => {
    const updated = await tx.flaggedItem.updateMany({
      where: { id: flag.id, status: "OPEN" },
      data: {
        status: confirm ? "CONFIRMED" : "DISMISSED",
        reviewNote: input.note || null,
        reviewedAt: now,
        // A confirmed logo photo is deleted below, so the flag no longer points at it.
        ...(confirm ? { storageKey: null } : {}),
      },
    });
    if (updated.count !== 1) {
      throw new AdminError("CONFLICT", "This flag has already been reviewed.");
    }
    await writeAudit(tx, actor, confirm ? "flag.confirmed" : "flag.dismissed", { type: "flagged_item", id: flag.id }, { photoDeleted: confirm && flag.storageKey !== null });
  });
  if (confirm && flag.storageKey && isSafeObjectKey(flag.storageKey)) {
    await storage.remove(BUCKETS.designAssets, [flag.storageKey]);
  }
}
