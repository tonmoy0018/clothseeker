"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser, type CurrentUser } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db";
import { addDesignToCart, DesignError, saveDesign, uploadDesignImage } from "@/lib/design/service";
import type { DesignIssue } from "@/lib/design/validate";
import { MAX_UPLOAD_BYTES } from "@/lib/media/process-image";
import { getStorage } from "@/lib/storage/supabase";

// Arguments come from our editor but are untrusted: the design service re-parses, revalidates
// and re-prices everything against the live template.

export type DesignActionResult =
  | { status: "ok"; designId: string; totalMinor: number }
  | { status: "signin" }
  | { status: "error"; message: string; issues: DesignIssue[] };

type CustomerCheck = { user: CurrentUser; result?: undefined } | { user?: undefined; result: Exclude<DesignActionResult, { status: "ok" }> };

async function customerOrResult(): Promise<CustomerCheck> {
  const user = await getCurrentUser();
  if (!user) {
    return { result: { status: "signin" } };
  }
  if (user.role !== "CUSTOMER") {
    return { result: { status: "error", message: "Admin accounts can't save designs. Sign in as a customer.", issues: [] } };
  }
  return { user };
}

function errorResult(error: unknown): DesignActionResult {
  if (error instanceof DesignError) {
    return { status: "error", message: error.message, issues: [...error.issues] };
  }
  throw error;
}

export async function saveDesignAction(designId: unknown, spec: unknown): Promise<DesignActionResult> {
  const { user, result } = await customerOrResult();
  if (!user) {
    return result;
  }
  try {
    const saved = await saveDesign(getPrisma(), getStorage(), user, { designId, spec });
    revalidatePath("/account/designs");
    return { status: "ok", designId: saved.designId, totalMinor: saved.price.totalMinor };
  } catch (error) {
    return errorResult(error);
  }
}

export async function addDesignToCartAction(designId: unknown, spec: unknown): Promise<DesignActionResult> {
  const { user, result } = await customerOrResult();
  if (!user) {
    return result;
  }
  try {
    const db = getPrisma();
    const storage = getStorage();
    const saved = await saveDesign(db, storage, user, { designId, spec });
    await addDesignToCart(db, storage, user, saved.designId);
    revalidatePath("/cart");
    revalidatePath("/account/designs");
    return { status: "ok", designId: saved.designId, totalMinor: saved.price.totalMinor };
  } catch (error) {
    return errorResult(error);
  }
}

export type UploadResult = { status: "ok"; key: string; url: string | null } | { status: "signin" } | { status: "error"; message: string };

export async function uploadDesignImageAction(formData: FormData): Promise<UploadResult> {
  const { user } = await customerOrResult();
  if (!user) {
    return { status: "signin" };
  }
  const file = formData.get("image");
  if (!(file instanceof File) || file.size === 0) {
    return { status: "error", message: "Choose an image to upload." };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { status: "error", message: "Images must be 4 MB or smaller." };
  }
  try {
    const uploaded = await uploadDesignImage(getStorage(), user, new Uint8Array(await file.arrayBuffer()));
    return { status: "ok", ...uploaded };
  } catch (error) {
    if (error instanceof DesignError) {
      return { status: "error", message: error.message };
    }
    throw error;
  }
}
