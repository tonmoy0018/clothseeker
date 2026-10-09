import { startOfDhakaDay } from "@/lib/ai/quota";
import { assertAdmin, type Actor } from "@/lib/auth/policy";
import type { PrismaClient } from "@/lib/db/client";
import type { AIJobStatus, AIJobType, AiLimitFeature } from "@/lib/generated/prisma/enums";

// Read-only AI health numbers for /admin/ai. Days are Dhaka calendar days, like the customer limits.

export const METRIC_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
export const JOB_TYPES: readonly AIJobType[] = ["DESIGN_ROUND", "DRESS_MATCH", "TRY_ON"];
export const LIMIT_FEATURES: readonly AiLimitFeature[] = ["DESIGN_ROUND", "TRY_ON", "SUBMISSIONS"];

// ─── pure calculations (unit tested) ─────────────────────────────────────────

/** Mean of the given durations in ms, or null when there are none. */
export function averageMs(durations: readonly number[]): number | null {
  return durations.length === 0 ? null : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
}

/** Failed share of finished jobs (0–1), or null when nothing finished. */
export function failureRate(succeeded: number, failed: number): number | null {
  const finished = succeeded + failed;
  return finished === 0 ? null : failed / finished;
}

/** Counts per Dhaka day for the last `days` days, oldest first. */
export function dailyCounts(dates: readonly Date[], now: Date, days = METRIC_DAYS): { day: Date; count: number }[] {
  const today = startOfDhakaDay(now).getTime();
  const buckets = Array.from({ length: days }, (_, i) => ({ day: new Date(today - (days - 1 - i) * DAY_MS), count: 0 }));
  for (const date of dates) {
    const index = days - 1 - Math.floor((today - startOfDhakaDay(date).getTime()) / DAY_MS);
    const bucket = buckets[index];
    if (bucket) bucket.count++;
  }
  return buckets;
}

/** Most frequent values first (e.g. failure codes). */
export function topCounts(values: readonly (string | null)[], limit = 5): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const v of values) {
    const key = v ?? "UNKNOWN";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, limit);
}

// ─── the page's numbers ──────────────────────────────────────────────────────

export type JobTypeMetrics = {
  type: AIJobType;
  today: Record<AIJobStatus, number>;
  series: { day: Date; count: number }[];
  queued: number;
  running: number;
  oldestQueuedAt: Date | null;
  averageWaitMs: number | null;
  averageRunMs: number | null;
  failureRate: number | null;
  topFailures: { value: string; count: number }[];
};

export type AiMetrics = {
  roundsToday: number;
  tryOnsToday: number;
  jobs: JobTypeMetrics[];
  limitHitsToday: Record<AiLimitFeature, number>;
  limitHitSeries: { day: Date; count: number }[];
  workers: { workerId: string; planner: string; image: string; tryOn: string; lastSeenAt: Date; startedAt: Date }[];
};

export async function getAiMetrics(db: PrismaClient, actor: Actor, now: Date = new Date()): Promise<AiMetrics> {
  assertAdmin(actor);
  const today = startOfDhakaDay(now);
  const since = new Date(today.getTime() - (METRIC_DAYS - 1) * DAY_MS);

  const [jobs, active, roundsToday, tryOnsToday, hits, workers] = await Promise.all([
    db.aIJob.findMany({
      where: { createdAt: { gte: since } },
      select: { type: true, status: true, createdAt: true, startedAt: true, finishedAt: true, errorCode: true },
      take: 50_000,
    }),
    db.aIJob.findMany({ where: { status: { in: ["QUEUED", "RUNNING"] } }, select: { type: true, status: true, createdAt: true } }),
    db.aIRound.count({ where: { createdAt: { gte: today } } }),
    db.tryOnResult.count({ where: { createdAt: { gte: today } } }),
    db.aiLimitHit.findMany({ where: { createdAt: { gte: since } }, select: { feature: true, createdAt: true } }),
    db.workerHeartbeat.findMany({ orderBy: { lastSeenAt: "desc" }, take: 10 }),
  ]);

  const perType = JOB_TYPES.map((type): JobTypeMetrics => {
    const all = jobs.filter((j) => j.type === type);
    const todays = all.filter((j) => j.createdAt >= today);
    const queuedNow = active.filter((j) => j.type === type && j.status === "QUEUED");
    const count = (status: AIJobStatus) => todays.filter((j) => j.status === status).length;
    return {
      type,
      today: { QUEUED: count("QUEUED"), RUNNING: count("RUNNING"), SUCCEEDED: count("SUCCEEDED"), FAILED: count("FAILED") },
      series: dailyCounts(all.map((j) => j.createdAt), now),
      queued: queuedNow.length,
      running: active.filter((j) => j.type === type && j.status === "RUNNING").length,
      oldestQueuedAt: queuedNow.reduce<Date | null>((oldest, j) => (!oldest || j.createdAt < oldest ? j.createdAt : oldest), null),
      averageWaitMs: averageMs(todays.flatMap((j) => (j.startedAt ? [j.startedAt.getTime() - j.createdAt.getTime()] : []))),
      averageRunMs: averageMs(todays.flatMap((j) => (j.startedAt && j.finishedAt ? [j.finishedAt.getTime() - j.startedAt.getTime()] : []))),
      failureRate: failureRate(count("SUCCEEDED"), count("FAILED")),
      topFailures: topCounts(todays.filter((j) => j.status === "FAILED").map((j) => j.errorCode)),
    };
  });

  const hitsToday = hits.filter((h) => h.createdAt >= today);
  return {
    roundsToday,
    tryOnsToday,
    jobs: perType,
    limitHitsToday: {
      DESIGN_ROUND: hitsToday.filter((h) => h.feature === "DESIGN_ROUND").length,
      TRY_ON: hitsToday.filter((h) => h.feature === "TRY_ON").length,
      SUBMISSIONS: hitsToday.filter((h) => h.feature === "SUBMISSIONS").length,
    },
    limitHitSeries: dailyCounts(hits.map((h) => h.createdAt), now),
    workers: workers.map((w) => ({ workerId: w.workerId, planner: w.planner, image: w.image, tryOn: w.tryOn, lastSeenAt: w.lastSeenAt, startedAt: w.startedAt })),
  };
}
