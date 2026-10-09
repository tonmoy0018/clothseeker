"use server";

import { getCurrentUser, type CurrentUser } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db";
import { MAX_UPLOAD_BYTES } from "@/lib/media/process-image";
import { getStorage } from "@/lib/storage/supabase";
import {
  createTryOnJob,
  deleteTryOnPhoto,
  getTryOnQuota,
  getTryOnStatus,
  listTryOnPhotos,
  setTryOnPhotoSaved,
  setTryOnResultSaved,
  TryOnError,
  uploadTryOnPhoto,
  type TryOnPhotoView,
  type TryOnStatus,
} from "@/lib/tryon/service";

// Virtual try-on actions, shared by the design screen and product pages. They only store photos and
// queue work; the worker runs the try-on. Arguments are untrusted and re-validated in lib/tryon.

type Failure = { status: "signin" } | { status: "error"; message: string };

async function customer(): Promise<CurrentUser | Failure> {
  const user = await getCurrentUser();
  if (!user) {
    return { status: "signin" };
  }
  if (user.role !== "CUSTOMER") {
    return { status: "error", message: "Try-on is for customer accounts." };
  }
  return user;
}

function isFailure(value: CurrentUser | Failure): value is Failure {
  return "status" in value;
}

function failure(error: unknown): Failure {
  if (error instanceof TryOnError) {
    return { status: "error", message: error.message };
  }
  throw error;
}

export type TryOnQuotaView = { used: number; limit: number; remaining: number };
export type TryOnOverview = { photos: TryOnPhotoView[]; quota: TryOnQuotaView | null };

export async function getTryOnOverviewAction(): Promise<TryOnOverview> {
  const user = await getCurrentUser();
  if (!user || user.role !== "CUSTOMER") {
    return { photos: [], quota: null };
  }
  const db = getPrisma();
  const [photos, quota] = await Promise.all([listTryOnPhotos(db, getStorage(), user), getTryOnQuota(db, user)]);
  return { photos, quota };
}

export type UploadPhotoResult = { status: "ok"; photo: TryOnPhotoView } | Failure;

export async function uploadTryOnPhotoAction(formData: FormData): Promise<UploadPhotoResult> {
  const user = await customer();
  if (isFailure(user)) {
    return user;
  }
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) {
    return { status: "error", message: "Choose a photo." };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { status: "error", message: "That photo is too large even after resizing. Try a smaller one." };
  }
  try {
    const photo = await uploadTryOnPhoto(getPrisma(), getStorage(), user, { bytes: new Uint8Array(await file.arrayBuffer()), consent: formData.get("consent") });
    return { status: "ok", photo };
  } catch (error) {
    return failure(error);
  }
}

export type StartTryOnResult = { status: "ok"; jobId: string; cached: boolean; quota: TryOnQuotaView } | Failure;

export async function startTryOnAction(input: unknown): Promise<StartTryOnResult> {
  const user = await customer();
  if (isFailure(user)) {
    return user;
  }
  try {
    const db = getPrisma();
    const queued = await createTryOnJob(db, getStorage(), user, input);
    return { status: "ok", ...queued, quota: await getTryOnQuota(db, user) };
  } catch (error) {
    return failure(error);
  }
}

export type TryOnStatusResult = { status: "ok"; job: TryOnStatus } | Failure;

export async function getTryOnStatusAction(jobId: unknown): Promise<TryOnStatusResult> {
  const user = await customer();
  if (isFailure(user)) {
    return user;
  }
  try {
    return { status: "ok", job: await getTryOnStatus(getPrisma(), getStorage(), user, jobId) };
  } catch (error) {
    return failure(error);
  }
}

export type SimpleResult = { status: "ok" } | Failure;

async function simple(run: (user: CurrentUser) => Promise<void>): Promise<SimpleResult> {
  const user = await customer();
  if (isFailure(user)) {
    return user;
  }
  try {
    await run(user);
    return { status: "ok" };
  } catch (error) {
    return failure(error);
  }
}

export async function savePhotoAction(photoId: unknown, saved: boolean): Promise<SimpleResult> {
  return simple((user) => setTryOnPhotoSaved(getPrisma(), user, photoId, saved === true));
}

export async function saveResultAction(resultId: unknown, saved: boolean): Promise<SimpleResult> {
  return simple((user) => setTryOnResultSaved(getPrisma(), user, resultId, saved === true));
}

export async function deletePhotoAction(photoId: unknown): Promise<SimpleResult> {
  return simple((user) => deleteTryOnPhoto(getPrisma(), getStorage(), user, photoId));
}
