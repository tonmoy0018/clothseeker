import { getPrisma } from "@/lib/db";
import { PaymentWebhookError } from "@/lib/orders/errors";
import { handlePaymentWebhook } from "@/lib/orders/payments";
import { getPaymentProvider } from "@/lib/payments";
import { WebhookVerificationError } from "@/lib/payments/types";
import { getStorage } from "@/lib/storage/supabase";

// Payment gateway webhook. Authenticated by the provider's signature (not cookies).
// 200 for processed or already-processed events; 400 for anything we refuse, so the gateway can alert.

const MAX_BODY_BYTES = 64 * 1024;

export async function POST(request: Request, { params }: RouteContext<"/api/payments/[provider]/webhook">) {
  const { provider: providerName } = await params;
  let provider;
  try {
    provider = getPaymentProvider(providerName);
  } catch {
    return Response.json({ error: "unknown_provider" }, { status: 404 });
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return Response.json({ error: "too_large" }, { status: 413 });
  }

  try {
    const outcome = await handlePaymentWebhook(getPrisma(), provider, getStorage(), rawBody, request.headers);
    return Response.json({ ok: true, outcome });
  } catch (error) {
    if (error instanceof WebhookVerificationError || error instanceof PaymentWebhookError) {
      console.warn(JSON.stringify({ level: "warn", msg: "payment.webhook_rejected", reason: error.name, code: "code" in error ? error.code : null }));
      return Response.json({ error: "rejected" }, { status: 400 });
    }
    throw error;
  }
}
