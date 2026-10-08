"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { requireUser } from "@/lib/auth/guards";
import { ForbiddenError } from "@/lib/auth/policy";
import { getPrisma } from "@/lib/db";
import { placeOrder, resumePayment } from "@/lib/orders/checkout";
import { OrderError } from "@/lib/orders/errors";
import { getPaymentProvider } from "@/lib/payments";
import { getStorage } from "@/lib/storage/supabase";

export type CheckoutState = { error?: string; fieldErrors?: Record<string, string> };

const returnUrlFor = (orderId: string) => `/account/orders/${orderId}`;

function field(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" ? value : undefined;
}

function toState(error: unknown): CheckoutState {
  if (error instanceof OrderError) {
    return { error: error.message };
  }
  if (error instanceof ForbiddenError) {
    return { error: "Only customer accounts can check out." };
  }
  if (error instanceof z.ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of error.issues) {
      fieldErrors[issue.path.join(".")] ??= issue.message;
    }
    return { error: "Please check the highlighted fields.", fieldErrors };
  }
  throw error;
}

export async function placeOrderAction(_prev: CheckoutState, formData: FormData): Promise<CheckoutState> {
  const user = await requireUser("/checkout");
  let redirectUrl: string;
  try {
    const placed = await placeOrder(
      getPrisma(),
      getStorage(),
      getPaymentProvider(),
      user,
      {
        idempotencyKey: field(formData, "idempotencyKey"),
        zone: field(formData, "zone"),
        address: {
          name: field(formData, "name"),
          phone: field(formData, "phone"),
          line1: field(formData, "line1"),
          line2: field(formData, "line2"),
          city: field(formData, "city"),
          postalCode: field(formData, "postalCode"),
        },
      },
      { returnUrlFor },
    );
    redirectUrl = placed.redirectUrl;
  } catch (error) {
    return toState(error);
  }
  redirect(redirectUrl);
}

export async function resumePaymentAction(_prev: CheckoutState, formData: FormData): Promise<CheckoutState> {
  const orderId = field(formData, "orderId");
  const user = await requireUser(`/account/orders/${orderId ?? ""}`);
  let redirectUrl: string;
  try {
    redirectUrl = (await resumePayment(getPrisma(), getPaymentProvider(), user, orderId, { returnUrlFor })).redirectUrl;
  } catch (error) {
    return toState(error);
  }
  redirect(redirectUrl);
}
