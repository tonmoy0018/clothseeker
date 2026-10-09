"use server";

import { revalidatePath } from "next/cache";

import { respondToQuote } from "@/lib/admin/quotes";
import { requireAdmin } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";

import { field, toFormState, type FormState } from "../../form-state";

export async function respondToQuoteAction(_state: FormState, formData: FormData): Promise<FormState> {
  const admin = await requireAdmin();
  const quoteId = field(formData, "quoteId");
  try {
    await respondToQuote(getPrisma(), admin, {
      action: field(formData, "action"),
      quoteId,
      priceTaka: field(formData, "priceTaka"),
      note: field(formData, "note"),
    });
  } catch (error) {
    return toFormState(error);
  }
  revalidatePath("/admin/quotes");
  revalidatePath(`/admin/quotes/${quoteId ?? ""}`);
  return { ok: field(formData, "action") === "price" ? "Price sent to the customer." : "Request declined." };
}
