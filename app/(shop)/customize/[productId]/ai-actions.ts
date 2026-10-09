"use server";

import { getCurrentUser, type CurrentUser } from "@/lib/auth/session";
import { AiError } from "@/lib/ai/errors";
import { createDesignRoundJob, getAiQuota, getJobStatus, listRounds, pickOption, uploadAiAttachment, type JobStatus, type RoundView } from "@/lib/ai/jobs";
import type { AiQuota } from "@/lib/ai/quota";
import { getPrisma } from "@/lib/db";
import { MAX_UPLOAD_BYTES } from "@/lib/media/process-image";
import { getStorage } from "@/lib/storage/supabase";
import type { DesignSpec } from "@/types/design-spec";

// The AI design box. These actions only queue work and read results; the worker calls the AI
// providers. Every argument is untrusted and re-validated in lib/ai/jobs.ts.

type Failure = { status: "signin" } | { status: "error"; message: string };

async function customer(): Promise<CurrentUser | Failure> {
  const user = await getCurrentUser();
  if (!user) {
    return { status: "signin" };
  }
  if (user.role !== "CUSTOMER") {
    return { status: "error", message: "The AI design helper is for customer accounts." };
  }
  return user;
}

function isFailure(value: CurrentUser | Failure): value is Failure {
  return "status" in value;
}

function failure(error: unknown): Failure {
  if (error instanceof AiError) {
    return { status: "error", message: error.message };
  }
  throw error;
}

export type RequestRoundResult = { status: "ok"; jobId: string; designId: string; cached: boolean; quota: AiQuota } | Failure;

export async function requestDesignRoundAction(input: unknown): Promise<RequestRoundResult> {
  const user = await customer();
  if (isFailure(user)) {
    return user;
  }
  try {
    const db = getPrisma();
    const queued = await createDesignRoundJob(db, getStorage(), user, input);
    return { status: "ok", ...queued, quota: await getAiQuota(db, user) };
  } catch (error) {
    return failure(error);
  }
}

export type JobStatusResult = { status: "ok"; job: JobStatus } | Failure;

export async function getJobStatusAction(jobId: unknown): Promise<JobStatusResult> {
  const user = await customer();
  if (isFailure(user)) {
    return user;
  }
  try {
    return { status: "ok", job: await getJobStatus(getPrisma(), getStorage(), user, jobId) };
  } catch (error) {
    return failure(error);
  }
}

export type AiOverview = { quota: AiQuota | null; rounds: RoundView[] };

/** Quota and earlier rounds for the AI box. Signed-out visitors get no quota and no rounds. */
export async function getAiOverviewAction(designId: unknown): Promise<AiOverview> {
  const user = await getCurrentUser();
  if (!user || user.role !== "CUSTOMER") {
    return { quota: null, rounds: [] };
  }
  const db = getPrisma();
  const [quota, rounds] = await Promise.all([getAiQuota(db, user), designId ? listRounds(db, getStorage(), user, designId) : Promise.resolve([])]);
  return { quota, rounds };
}

export type PickResult = { status: "ok"; spec: DesignSpec; imageUrls: Record<string, string> } | Failure;

export async function pickOptionAction(roundId: unknown, optionIndex: unknown): Promise<PickResult> {
  const user = await customer();
  if (isFailure(user)) {
    return user;
  }
  try {
    const picked = await pickOption(getPrisma(), getStorage(), user, { roundId, optionIndex });
    return { status: "ok", spec: picked.spec, imageUrls: picked.imageUrls };
  } catch (error) {
    return failure(error);
  }
}

export type AttachmentResult = { status: "ok"; key: string; url: string | null } | Failure;

export async function uploadAiAttachmentAction(formData: FormData): Promise<AttachmentResult> {
  const user = await customer();
  if (isFailure(user)) {
    return user;
  }
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) {
    return { status: "error", message: "Choose a photo to attach." };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { status: "error", message: "That photo is too large even after resizing. Try a smaller one." };
  }
  try {
    return { status: "ok", ...(await uploadAiAttachment(getStorage(), user, new Uint8Array(await file.arrayBuffer()))) };
  } catch (error) {
    return failure(error);
  }
}
