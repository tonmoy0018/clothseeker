import type { PrismaClient } from "@/lib/db/client";

// Each worker poll records that the worker is alive and which providers it runs, so /admin/ai can
// show "worker last seen 3 s ago · planner gemini". Entries of workers gone for a week are removed.

const FORGET_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export type Heartbeat = { workerId: string; planner: string; image: string; tryOn: string; startedAt: Date };

export async function recordHeartbeat(db: PrismaClient, beat: Heartbeat, now: Date = new Date()): Promise<void> {
  await db.workerHeartbeat.upsert({
    where: { workerId: beat.workerId },
    create: { ...beat, lastSeenAt: now },
    update: { planner: beat.planner, image: beat.image, tryOn: beat.tryOn, lastSeenAt: now },
  });
  await db.workerHeartbeat.deleteMany({ where: { lastSeenAt: { lt: new Date(now.getTime() - FORGET_AFTER_MS) } } });
}
