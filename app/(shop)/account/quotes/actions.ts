"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db";
import { acceptQuote, QuoteError, requestQuote, withdrawQuote } from "@/lib/quotes/service";
import { getStorage } from "@/lib/storage/supabase";

// Tailoring quotes, customer side. Arguments are untrusted and re-validated in lib/quotes.

export type QuoteActionResult = { status: "ok"; quoteId: string } | { status: "signin" } | { status: "error"; message: string };

async function customerOrResult() {
  const user = await getCurrentUser();
  if (!user) return { result: { status: "signin" } as const };
  if (user.role !== "CUSTOMER") return { result: { status: "error", message: "Quotes are for customer accounts." } as const };
  return { user };
}

export async function requestQuoteAction(designId: unknown, notes: unknown): Promise<QuoteActionResult> {
  const { user, result } = await customerOrResult();
  if (!user) return result;
  try {
    const { quoteId } = await requestQuote(getPrisma(), getStorage(), user, { designId, notes });
    revalidatePath("/account/quotes");
    return { status: "ok", quoteId };
  } catch (error) {
    if (error instanceof QuoteError) return { status: "error", message: error.message };
    throw error;
  }
}

export type QuoteFormState = { error: string | null };

export async function acceptQuoteAction(_state: QuoteFormState, formData: FormData): Promise<QuoteFormState> {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/account/quotes");
  if (user.role !== "CUSTOMER") return { error: "Quotes are for customer accounts." };
  try {
    await acceptQuote(getPrisma(), user, formData.get("quoteId"));
  } catch (error) {
    if (error instanceof QuoteError) return { error: error.message };
    throw error;
  }
  revalidatePath("/cart");
  redirect("/cart");
}

export async function withdrawQuoteAction(_state: QuoteFormState, formData: FormData): Promise<QuoteFormState> {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/account/quotes");
  if (user.role !== "CUSTOMER") return { error: "Quotes are for customer accounts." };
  const quoteId = formData.get("quoteId");
  try {
    await withdrawQuote(getPrisma(), user, quoteId);
  } catch (error) {
    if (error instanceof QuoteError) return { error: error.message };
    throw error;
  }
  revalidatePath("/account/quotes");
  revalidatePath("/cart");
  return { error: null };
}
