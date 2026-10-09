"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db";
import { DisputeError, openDispute } from "@/lib/disputes/service";
import { MAX_UPLOAD_BYTES } from "@/lib/media/process-image";
import { getStorage } from "@/lib/storage/supabase";

export type ReportState = { error: string | null; done: boolean };

/** "Report a problem" with a delivered item. Everything is re-checked in lib/disputes. */
export async function reportProblemAction(_state: ReportState, formData: FormData): Promise<ReportState> {
  const user = await getCurrentUser();
  if (!user || user.role !== "CUSTOMER") {
    return { error: "Please sign in again.", done: false };
  }
  const files = formData.getAll("photos").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.some((f) => f.size > MAX_UPLOAD_BYTES)) {
    return { error: "A photo is too large even after resizing. Try a smaller one.", done: false };
  }
  try {
    await openDispute(getPrisma(), getStorage(), user, {
      itemId: formData.get("itemId"),
      reason: formData.get("reason"),
      photos: await Promise.all(files.map(async (f) => new Uint8Array(await f.arrayBuffer()))),
    });
  } catch (error) {
    if (error instanceof DisputeError) {
      return { error: error.message, done: false };
    }
    throw error;
  }
  revalidatePath(`/account/orders/${String(formData.get("orderId") ?? "")}`);
  return { error: null, done: true };
}
