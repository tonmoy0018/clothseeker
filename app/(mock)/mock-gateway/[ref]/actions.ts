"use server";

import { randomUUID } from "node:crypto";

import { redirect } from "next/navigation";
import { z } from "zod";

import { requireUser } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { getServerEnv } from "@/lib/env/server";
import { getPaymentForCustomer } from "@/lib/orders/queries";
import { MOCK_SIGNATURE_HEADER, MockPaymentProvider } from "@/lib/payments/mock";

// Plays the role of the payment gateway's servers: builds the result event, signs it with the
// shared secret and POSTs it to our public webhook endpoint — the same path a real gateway uses.

export type GatewayState = { error?: string };

const inputSchema = z.object({
  ref: z.string().regex(/^mockpay_[0-9a-f]{24}$/),
  outcome: z.enum(["succeeded", "failed"]),
  returnTo: z.string().regex(/^\/account\/orders\/[0-9a-f-]{36}$/),
});

export async function completeMockPaymentAction(_prev: GatewayState, formData: FormData): Promise<GatewayState> {
  const input = inputSchema.safeParse({
    ref: formData.get("ref"),
    outcome: formData.get("outcome"),
    returnTo: formData.get("returnTo"),
  });
  if (!input.success) {
    return { error: "This payment link isn't valid." };
  }
  const user = await requireUser(`/mock-gateway/${input.data.ref}`);
  const payment = await getPaymentForCustomer(getPrisma(), user, input.data.ref);
  if (!payment) {
    return { error: "This payment link isn't valid." };
  }

  const env = getServerEnv();
  const gateway = new MockPaymentProvider(env.MOCK_PAYMENT_WEBHOOK_SECRET);
  const body = JSON.stringify({
    eventId: `evt_${randomUUID()}`,
    type: input.data.outcome === "succeeded" ? "payment.succeeded" : "payment.failed",
    providerRef: payment.providerRef,
    amountMinor: payment.amountMinor,
    currency: payment.currency,
  });
  try {
    const response = await fetch(new URL("/api/payments/mock/webhook", env.NEXT_PUBLIC_APP_URL), {
      method: "POST",
      headers: { "content-type": "application/json", [MOCK_SIGNATURE_HEADER]: gateway.sign(body) },
      body,
      cache: "no-store",
    });
    if (!response.ok) {
      return { error: "The shop didn't accept the payment notification. Please try again." };
    }
  } catch {
    return { error: "Couldn't reach the shop. Please try again." };
  }
  redirect(input.data.returnTo);
}
