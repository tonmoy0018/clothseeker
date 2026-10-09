"use server";

import { getCurrentUser, type CurrentUser } from "@/lib/auth/session";
import { AiError } from "@/lib/ai/errors";
import { getStartStatus, startDesignFrom, uploadReferencePhoto, type StartStatus } from "@/lib/ai/starts";
import { getPrisma } from "@/lib/db";
import { MAX_UPLOAD_BYTES } from "@/lib/media/process-image";
import { getStorage } from "@/lib/storage/supabase";

// Start a design from a dress photo or a description. Only queues work; the worker matches the dress.

type Failure = { status: "signin" } | { status: "error"; message: string };

async function customer(): Promise<CurrentUser | Failure> {
  const user = await getCurrentUser();
  if (!user) {
    return { status: "signin" };
  }
  if (user.role !== "CUSTOMER") {
    return { status: "error", message: "Starting a design is for customer accounts." };
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

export type StartResult = { status: "ok"; jobId: string } | Failure;

export async function startFromPhotoAction(formData: FormData): Promise<StartResult> {
  const user = await customer();
  if (isFailure(user)) {
    return user;
  }
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) {
    return { status: "error", message: "Choose a photo of the dress." };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { status: "error", message: "That photo is too large even after resizing. Try a smaller one." };
  }
  try {
    const storage = getStorage();
    const photo = await uploadReferencePhoto(storage, user, new Uint8Array(await file.arrayBuffer()));
    const started = await startDesignFrom(getPrisma(), storage, user, { mode: "photo", referenceKey: photo.key });
    return { status: "ok", jobId: started.jobId };
  } catch (error) {
    return failure(error);
  }
}

export async function startFromDescriptionAction(description: unknown): Promise<StartResult> {
  const user = await customer();
  if (isFailure(user)) {
    return user;
  }
  try {
    const started = await startDesignFrom(getPrisma(), getStorage(), user, { mode: "description", description });
    return { status: "ok", jobId: started.jobId };
  } catch (error) {
    return failure(error);
  }
}

export type StartStatusResult = { status: "ok"; job: StartStatus } | Failure;

export async function getStartStatusAction(jobId: unknown): Promise<StartStatusResult> {
  const user = await customer();
  if (isFailure(user)) {
    return user;
  }
  try {
    return { status: "ok", job: await getStartStatus(getPrisma(), user, jobId) };
  } catch (error) {
    return failure(error);
  }
}
