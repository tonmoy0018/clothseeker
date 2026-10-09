import { getCourier } from "@/lib/couriers";
import { CourierWebhookVerificationError } from "@/lib/couriers/types";
import { getPrisma } from "@/lib/db";
import { CourierWebhookError, handleCourierWebhook } from "@/lib/production/shipping";

// Courier status webhook. Authenticated by the courier's signature (not cookies).

const MAX_BODY_BYTES = 16 * 1024;

export async function POST(request: Request, { params }: RouteContext<"/api/couriers/[courier]/webhook">) {
  const { courier: name } = await params;
  let courier;
  try {
    courier = getCourier(name);
  } catch {
    return Response.json({ error: "unknown_courier" }, { status: 404 });
  }
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return Response.json({ error: "too_large" }, { status: 413 });
  }
  try {
    const outcome = await handleCourierWebhook(getPrisma(), courier, rawBody, request.headers);
    return Response.json({ ok: true, outcome });
  } catch (error) {
    if (error instanceof CourierWebhookVerificationError || error instanceof CourierWebhookError) {
      console.warn(JSON.stringify({ level: "warn", msg: "courier.webhook_rejected", reason: error.name }));
      return Response.json({ error: "rejected" }, { status: 400 });
    }
    throw error;
  }
}
