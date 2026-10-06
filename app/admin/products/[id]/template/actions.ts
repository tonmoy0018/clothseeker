"use server";

import { revalidatePath } from "next/cache";

import { saveTemplate, setTemplateState, uploadTemplateImage } from "@/lib/admin/templates";
import { requireAdmin } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { MAX_UPLOAD_BYTES } from "@/lib/media/process-image";
import { getStorage } from "@/lib/storage/supabase";

import { field, fileBytes, toFormState, type FormState } from "../../../form-state";

export type SaveResult =
  | { ok: true; version: number }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

function refresh(productId: string): void {
  revalidatePath(`/admin/products/${productId}`, "layout");
  revalidatePath("/", "layout");
}

/** Arguments are untrusted even though they come from our own editor: the service re-validates them. */
export async function saveTemplateAction(productId: unknown, expectedVersion: unknown, config: unknown): Promise<SaveResult> {
  const admin = await requireAdmin();
  try {
    const { version } = await saveTemplate(getPrisma(), getStorage(), admin, { productId, expectedVersion, config });
    if (typeof productId === "string") {
      refresh(productId);
    }
    return { ok: true, version };
  } catch (error) {
    const state = toFormState(error);
    return { ok: false, error: state.error ?? "Couldn't save.", fieldErrors: state.fieldErrors };
  }
}

export async function setTemplateStateAction(productId: unknown, isActive: unknown, aiEnabled: unknown): Promise<FormState> {
  const admin = await requireAdmin();
  try {
    await setTemplateState(getPrisma(), admin, { productId, isActive, aiEnabled });
    if (typeof productId === "string") {
      refresh(productId);
    }
    return { ok: isActive ? "Template is live for customers." : "Template saved as not live." };
  } catch (error) {
    return toFormState(error);
  }
}

export type UploadResult = { key: string; url: string | null; error?: undefined } | { error: string };

export async function uploadTemplateImageAction(formData: FormData): Promise<UploadResult> {
  const admin = await requireAdmin();
  const bytes = await fileBytes(formData, "image", MAX_UPLOAD_BYTES);
  if (!(bytes instanceof Uint8Array)) {
    return { error: bytes.error ?? "Choose an image." };
  }
  try {
    return await uploadTemplateImage(
      getPrisma(),
      getStorage(),
      admin,
      { productId: field(formData, "productId"), slot: field(formData, "slot") },
      bytes,
    );
  } catch (error) {
    return { error: toFormState(error).error ?? "Upload failed." };
  }
}
