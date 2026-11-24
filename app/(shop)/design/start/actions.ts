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

export type UploadResult = { status: "ok"; key: string; url: string | null } | Failure;

/** Stores the customer's dress photo; they then choose what to do with it (startFromPhotoAction). */
export async function uploadDressPhotoAction(formData: FormData): Promise<UploadResult> {
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
    const photo = await uploadReferencePhoto(getStorage(), user, new Uint8Array(await file.arrayBuffer()));
    return { status: "ok", key: photo.key, url: photo.url };
  } catch (error) {
    return failure(error);
  }
}

/**
 * What to make of an uploaded dress photo: our closest dress ("closest"), their own dress to customise
 * ("customize") or exactly as it is ("exact"). `sketch`: the photo is a drawing, made into a realistic
 * picture first, with the customer's `note` on its fabric. Everything is re-checked in lib/ai/starts.ts.
 */
export async function startFromPhotoAction(
  referenceKey: unknown,
  choice: unknown,
  garmentType: unknown,
  sketch: unknown = false,
  note: unknown = undefined,
  renderKey: unknown = undefined,
): Promise<StartResult> {
  const user = await customer();
  if (isFailure(user)) {
    return user;
  }
  const input =
    choice === "closest"
      ? { mode: "photo", referenceKey, sketch }
      : { mode: "own", referenceKey, garmentType, exact: choice === "exact", sketch, note: note === "" ? undefined : note, renderKey };
  if (choice !== "closest" && choice !== "customize" && choice !== "exact") {
    return { status: "error", message: "Choose what to do with your photo." };
  }
  try {
    const started = await startDesignFrom(getPrisma(), getStorage(), user, input);
    return { status: "ok", jobId: started.jobId };
  } catch (error) {
    return failure(error);
  }
}

/**
 * A drawing: realistic pictures of the garment first, to pick the closest from (`round` > 0: "show me
 * more"). The picked one then goes to startFromPhotoAction as `renderKey`.
 */
export async function renderSketchAction(referenceKey: unknown, note: unknown, round: unknown): Promise<StartResult> {
  const user = await customer();
  if (isFailure(user)) {
    return user;
  }
  try {
    const started = await startDesignFrom(getPrisma(), getStorage(), user, { mode: "sketch", referenceKey, note: note === "" ? undefined : note, round });
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
    return { status: "ok", job: await getStartStatus(getPrisma(), getStorage(), user, jobId) };
  } catch (error) {
    return failure(error);
  }
}
