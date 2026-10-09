import { z } from "zod";

import type { PrismaClient } from "@/lib/db/client";
import { Prisma } from "@/lib/generated/prisma/client";
import { AIJobType } from "@/lib/generated/prisma/enums";

// Safe job claiming for any number of workers. One statement picks the oldest due QUEUED job,
// skipping rows another worker has locked (FOR UPDATE SKIP LOCKED), and marks it RUNNING with
// this worker's id. Two workers can never claim the same job.

export type ClaimedJob = {
  id: string;
  type: AIJobType;
  customerId: string;
  payload: unknown;
  inputHash: string;
  /** Including this attempt. */
  attempts: number;
  maxAttempts: number;
};

const rowSchema = z.object({
  id: z.string(),
  type: z.enum(AIJobType),
  customer_id: z.string(),
  payload: z.unknown(),
  input_hash: z.string(),
  attempts: z.number().int(),
  max_attempts: z.number().int(),
});

/** Columns are `timestamp(3)` holding UTC wall-clock time, as Prisma writes them. */
export function utcTimestamp(date: Date): Prisma.Sql {
  return Prisma.sql`(${date.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

export async function claimNextJob(db: PrismaClient, workerId: string, now: Date): Promise<ClaimedJob | null> {
  const at = utcTimestamp(now);
  const rows = await db.$queryRaw<unknown[]>`
    UPDATE "ai_jobs"
       SET "status" = 'RUNNING', "attempts" = "attempts" + 1, "locked_at" = ${at}, "locked_by" = ${workerId},
           "started_at" = COALESCE("started_at", ${at}), "updated_at" = ${at}
     WHERE "id" = (
       SELECT "id" FROM "ai_jobs"
        WHERE "status" = 'QUEUED' AND "run_after" <= ${at}
        ORDER BY "run_after", "created_at"
        FOR UPDATE SKIP LOCKED
        LIMIT 1)
    RETURNING "id", "type"::text AS "type", "customer_id", "payload", "input_hash", "attempts", "max_attempts"`;
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  const job = rowSchema.parse(row);
  return {
    id: job.id,
    type: job.type,
    customerId: job.customer_id,
    payload: job.payload,
    inputHash: job.input_hash,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
  };
}

/** Only the worker holding this attempt's lease may finish the job. */
export function leaseWhere(job: ClaimedJob, workerId: string): Prisma.AIJobWhereInput {
  return { id: job.id, status: "RUNNING", lockedBy: workerId, attempts: job.attempts };
}

/** The job was recovered or finished elsewhere while this worker was still working on it. */
export class LostLease extends Error {
  override readonly name = "LostLease";
}
