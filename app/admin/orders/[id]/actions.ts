"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getCourier } from "@/lib/couriers";
import { MOCK_COURIER_SIGNATURE_HEADER } from "@/lib/couriers/mock";
import { requireAdmin } from "@/lib/auth/guards";
import { ForbiddenError } from "@/lib/auth/policy";
import { getPrisma } from "@/lib/db";
import { getServerEnv } from "@/lib/env/server";
import { MAX_UPLOAD_BYTES } from "@/lib/media/process-image";
import { getPaymentProvider } from "@/lib/payments";
import { acceptItem, declineItem } from "@/lib/production/acceptance";
import { ProductionError } from "@/lib/production/errors";
import { approveQc, markReadyToShip, rejectQc, startProduction, submitQc, uploadQcPhoto } from "@/lib/production/production";
import { shipItem } from "@/lib/production/shipping";
import { getStorage } from "@/lib/storage/supabase";

import { fileBytes, type FormState } from "../../form-state";

// Thin wrappers: authorize, call the production service, map expected errors, refresh.

function field(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" ? value : undefined;
}

function toState(error: unknown): FormState {
  if (error instanceof ProductionError) return { error: error.message };
  if (error instanceof ForbiddenError) return { error: "You don't have permission to do that." };
  if (error instanceof z.ZodError) return { error: error.issues[0]?.message ?? "Check the form." };
  throw error;
}

function refresh(orderId: string | undefined): void {
  revalidatePath("/admin", "layout");
  if (orderId) revalidatePath(`/account/orders/${orderId}`);
}

/** Callers have already checked requireAdmin(); the services check the role again. */
async function run(formData: FormData, ok: string, action: (itemId: string | undefined) => Promise<unknown>): Promise<FormState> {
  try {
    await action(field(formData, "itemId"));
  } catch (error) {
    return toState(error);
  }
  refresh(field(formData, "orderId"));
  return { ok };
}

export async function acceptAction(_p: FormState, formData: FormData): Promise<FormState> {
  const admin = await requireAdmin();
  return run(formData, "Accepted.", (itemId) => acceptItem(getPrisma(), admin, itemId));
}

export async function declineAction(_p: FormState, formData: FormData): Promise<FormState> {
  const admin = await requireAdmin();
  return run(formData, "Declined and refunded.", (itemId) =>
    declineItem(getPrisma(), getPaymentProvider(), admin, { itemId, reason: field(formData, "reason") }),
  );
}

export async function readyAction(_p: FormState, formData: FormData): Promise<FormState> {
  const admin = await requireAdmin();
  return run(formData, "Marked ready to ship.", (itemId) => markReadyToShip(getPrisma(), admin, itemId));
}

export async function startProductionAction(_p: FormState, formData: FormData): Promise<FormState> {
  const admin = await requireAdmin();
  return run(formData, "Production started.", (itemId) => startProduction(getPrisma(), admin, itemId));
}

export async function qcPhotoAction(_p: FormState, formData: FormData): Promise<FormState> {
  const admin = await requireAdmin();
  const bytes = await fileBytes(formData, "photo", MAX_UPLOAD_BYTES);
  if (!(bytes instanceof Uint8Array)) return bytes;
  return run(formData, "Photo added.", (itemId) => uploadQcPhoto(getPrisma(), getStorage(), admin, { itemId, side: field(formData, "side") }, bytes));
}

export async function submitQcAction(_p: FormState, formData: FormData): Promise<FormState> {
  const admin = await requireAdmin();
  return run(formData, "Submitted for QC.", (itemId) => submitQc(getPrisma(), admin, itemId));
}

export async function approveQcAction(_p: FormState, formData: FormData): Promise<FormState> {
  const admin = await requireAdmin();
  return run(formData, "QC passed.", (itemId) => approveQc(getPrisma(), admin, itemId));
}

export async function rejectQcAction(_p: FormState, formData: FormData): Promise<FormState> {
  const admin = await requireAdmin();
  return run(formData, "Sent back to production.", (itemId) => rejectQc(getPrisma(), admin, { itemId, note: field(formData, "note") }));
}

export async function shipAction(_p: FormState, formData: FormData): Promise<FormState> {
  const admin = await requireAdmin();
  return run(formData, "Shipped.", (itemId) => shipItem(getPrisma(), getCourier(), admin, { itemId }));
}

const courierSchema = z.object({
  trackingNumber: z.string().regex(/^MCK[A-Z0-9]{10}$/),
  status: z.enum(["in_transit", "out_for_delivery", "delivered"]),
});

/** Plays the courier's servers: signs a status update and POSTs it to our public webhook. */
export async function simulateCourierAction(_p: FormState, formData: FormData): Promise<FormState> {
  await requireAdmin();
  const input = courierSchema.safeParse({ trackingNumber: field(formData, "trackingNumber"), status: field(formData, "status") });
  if (!input.success) return { error: "That shipment isn't valid." };
  const body = JSON.stringify({ eventId: `cev_${randomUUID()}`, ...input.data });
  try {
    const response = await fetch(new URL("/api/couriers/mock/webhook", getServerEnv().NEXT_PUBLIC_APP_URL), {
      method: "POST",
      headers: { "content-type": "application/json", [MOCK_COURIER_SIGNATURE_HEADER]: getCourier().sign(body) },
      body,
      cache: "no-store",
    });
    if (!response.ok) return { error: "The courier update was rejected." };
  } catch {
    return { error: "Couldn't reach the courier webhook." };
  }
  refresh(field(formData, "orderId"));
  return { ok: "Courier update sent." };
}
