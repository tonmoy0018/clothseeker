"use server";

import { revalidatePath } from "next/cache";

import { resolveDispute } from "@/lib/admin/disputes";
import { requireAdmin } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { getPaymentProvider } from "@/lib/payments";
import { ProductionError } from "@/lib/production/errors";

import { field, toFormState, type FormState } from "../../form-state";

export async function resolveDisputeAction(_state: FormState, formData: FormData): Promise<FormState> {
  const admin = await requireAdmin();
  const disputeId = field(formData, "disputeId");
  try {
    await resolveDispute(getPrisma(), getPaymentProvider(), admin, { disputeId, outcome: field(formData, "outcome"), note: field(formData, "note") });
  } catch (error) {
    if (error instanceof ProductionError) {
      return { error: error.message };
    }
    return toFormState(error);
  }
  revalidatePath("/admin/disputes");
  revalidatePath(`/admin/disputes/${disputeId ?? ""}`);
  return { ok: "Dispute resolved." };
}
