"use server";

import { revalidatePath } from "next/cache";

import { reviewFlag } from "@/lib/admin/flags";
import { requireAdmin } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { getStorage } from "@/lib/storage/supabase";

import { field, toFormState, type FormState } from "../form-state";

export async function reviewFlagAction(_state: FormState, formData: FormData): Promise<FormState> {
  const admin = await requireAdmin();
  try {
    await reviewFlag(getPrisma(), getStorage(), admin, { flagId: field(formData, "flagId"), decision: field(formData, "decision"), note: field(formData, "note") });
  } catch (error) {
    return toFormState(error);
  }
  revalidatePath("/admin/flags");
  revalidatePath("/admin");
  return { ok: "Saved." };
}
