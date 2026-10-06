"use server";

import { revalidatePath } from "next/cache";

import { requireUser } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { deleteDesign, DesignError } from "@/lib/design/service";
import { getStorage } from "@/lib/storage/supabase";

export type DeleteState = { error?: string };

export async function deleteDesignAction(_prev: DeleteState, formData: FormData): Promise<DeleteState> {
  const user = await requireUser("/account/designs");
  try {
    await deleteDesign(getPrisma(), getStorage(), user, formData.get("designId"));
  } catch (error) {
    if (error instanceof DesignError) {
      return { error: error.message };
    }
    throw error;
  }
  revalidatePath("/account/designs");
  revalidatePath("/cart");
  return {};
}
