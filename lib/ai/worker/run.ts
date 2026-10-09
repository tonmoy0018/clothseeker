import { ZodError } from "zod";

import type { PrismaClient } from "@/lib/db/client";
import type { StorageAdapter } from "@/lib/storage/adapter";

import { AiJobRejected, AiProviderError, type AiFailureCode } from "../errors";
import type { AiProviders } from "../types";

import { claimNextJob, leaseWhere, LostLease, type ClaimedJob } from "./claim";
import { runDesignRound } from "./design-round";
import { runDressMatch } from "./dress-match";
import { runTryOn } from "./try-on";

// Runs claimed AI jobs with a hard timeout, retries transient failures with backoff, and recovers
// jobs whose worker died. Logs carry ids, counts, durations and codes only — never prompts or images.

export type AiLog = (msg: string, fields: Record<string, string | number | boolean | null | undefined>) => void;

export type AiWorkerDeps = {
  db: PrismaClient;
  storage: StorageAdapter;
  providers: AiProviders;
  workerId: string;
  /** Limit for one attempt; the job is aborted and retried (or failed) after this. */
  timeoutMs: number;
  /** Per job type overrides of timeoutMs (try-ons on free Spaces queue for a while). */
  timeoutsMs?: Partial<Record<ClaimedJob["type"], number>>;
  now?: () => Date;
  log?: AiLog;
  /** Delay before retry number `attempt` (1-based). */
  backoffMs?: (attempt: number) => number;
};

/** 10 s, then 40 s. */
export const defaultBackoffMs = (attempt: number) => 10_000 * 4 ** Math.max(0, attempt - 1);

type Failure = { code: AiFailureCode; retryable: boolean; detail: string };

function classify(error: unknown): Failure {
  if (error instanceof AiJobRejected) {
    return { code: error.code, retryable: false, detail: error.code };
  }
  if (error instanceof AiProviderError) {
    return { code: error.code, retryable: error.retryable, detail: error.message };
  }
  if (error instanceof ZodError) {
    return { code: "INVALID_PLAN", retryable: true, detail: "ZodError" };
  }
  // Unexpected errors (database or storage hiccups) are retried; the attempt limit still applies.
  return { code: "INTERNAL", retryable: true, detail: error instanceof Error ? error.name : "UnknownError" };
}

async function execute(deps: AiWorkerDeps, job: ClaimedJob, signal: AbortSignal): Promise<void> {
  switch (job.type) {
    case "DESIGN_ROUND":
      return runDesignRound(deps, job, signal);
    case "TRY_ON":
      return runTryOn(deps, job, signal);
    case "DRESS_MATCH":
      return runDressMatch(deps, job, signal);
  }
}

/** Claims and runs one job. Returns false when nothing was due. */
export async function processNextJob(deps: AiWorkerDeps): Promise<boolean> {
  const now = deps.now ?? (() => new Date());
  const job = await claimNextJob(deps.db, deps.workerId, now());
  if (!job) {
    return false;
  }
  const started = Date.now();
  deps.log?.("ai.job_started", { jobId: job.id, type: job.type, attempt: job.attempts });

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AiProviderError("job timed out", true, "TIMEOUT"));
    }, deps.timeoutsMs?.[job.type] ?? deps.timeoutMs);
  });
  const work = execute(deps, job, controller.signal);
  // After a timeout the work may still settle later; its outcome is ignored (the lease is gone).
  work.catch(() => undefined);

  try {
    await Promise.race([work, timeout]);
    deps.log?.("ai.job_succeeded", { jobId: job.id, type: job.type, attempt: job.attempts, ms: Date.now() - started });
  } catch (error) {
    controller.abort();
    if (error instanceof LostLease) {
      deps.log?.("ai.job_lease_lost", { jobId: job.id });
      return true;
    }
    const failure = classify(error);
    const retry = failure.retryable && job.attempts < job.maxAttempts;
    const at = now();
    const updated = await deps.db.aIJob.updateMany({
      where: leaseWhere(job, deps.workerId),
      data: retry
        ? { status: "QUEUED", runAfter: new Date(at.getTime() + (deps.backoffMs ?? defaultBackoffMs)(job.attempts)), lockedAt: null, lockedBy: null, error: failure.detail.slice(0, 200), errorCode: failure.code }
        : { status: "FAILED", finishedAt: at, lockedAt: null, lockedBy: null, error: failure.detail.slice(0, 200), errorCode: failure.code },
    });
    deps.log?.(retry ? "ai.job_retry" : "ai.job_failed", {
      jobId: job.id,
      type: job.type,
      attempt: job.attempts,
      code: failure.code,
      ms: Date.now() - started,
      leaseHeld: updated.count === 1,
    });
  } finally {
    clearTimeout(timer);
  }
  return true;
}

/**
 * RUNNING jobs whose lease is older than `staleAfterMs` belong to a worker that died or hung:
 * requeue them, or fail them once their attempts are used up.
 */
export async function recoverStuckJobs(db: PrismaClient, now: Date, staleAfterMs: number): Promise<number> {
  const stale = { status: "RUNNING" as const, lockedAt: { lt: new Date(now.getTime() - staleAfterMs) } };
  const failed = await db.aIJob.updateMany({
    where: { ...stale, attempts: { gte: db.aIJob.fields.maxAttempts } },
    data: { status: "FAILED", finishedAt: now, lockedAt: null, lockedBy: null, error: "stale lease", errorCode: "TIMEOUT" },
  });
  const requeued = await db.aIJob.updateMany({
    where: stale,
    data: { status: "QUEUED", runAfter: now, lockedAt: null, lockedBy: null, error: "stale lease" },
  });
  return failed.count + requeued.count;
}

/** One worker poll: recover stuck jobs, then run due jobs one at a time (free tiers dislike bursts). */
export async function runAiJobs(deps: AiWorkerDeps, maxJobs = 5): Promise<number> {
  const now = deps.now ?? (() => new Date());
  const longest = Math.max(deps.timeoutMs, ...Object.values(deps.timeoutsMs ?? {}));
  const recovered = await recoverStuckJobs(deps.db, now(), longest + 60_000);
  if (recovered > 0) {
    deps.log?.("ai.jobs_recovered", { count: recovered });
  }
  let processed = 0;
  while (processed < maxJobs && (await processNextJob(deps))) {
    processed++;
  }
  return processed;
}

