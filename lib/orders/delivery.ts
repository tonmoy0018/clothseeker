import { z } from "zod";

import { DeliveryZone } from "@/lib/generated/prisma/enums";

// Delivery fees and the shipping address we keep — the minimum needed to deliver a parcel.

export const DELIVERY_ZONES: readonly DeliveryZone[] = ["INSIDE_DHAKA", "OUTSIDE_DHAKA"];

export const DELIVERY_FEES_MINOR: Record<DeliveryZone, number> = {
  INSIDE_DHAKA: 8_000,
  OUTSIDE_DHAKA: 15_000,
};

export const DELIVERY_ZONE_LABEL: Record<DeliveryZone, string> = {
  INSIDE_DHAKA: "Inside Dhaka",
  OUTSIDE_DHAKA: "Outside Dhaka",
};

/** Bangladeshi mobile numbers: 01[3-9]XXXXXXXX, optionally written with +880 / 880. Normalized to 01… form. */
export const bdMobileSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ""))
  .transform((v) => v.replace(/^\+?880/, "0"))
  .pipe(z.string().regex(/^01[3-9]\d{8}$/, "Enter a valid Bangladeshi mobile number, e.g. 01712345678"));

const line = (label: string, max: number) => z.string().trim().min(2, `Enter ${label}`).max(max);

export const shippingAddressSchema = z.object({
  name: line("the recipient's name", 80),
  phone: bdMobileSchema,
  line1: line("the street address", 120),
  line2: z.string().trim().max(120).optional().transform((v) => (v ? v : undefined)),
  city: line("the city or district", 60),
  postalCode: z
    .string()
    .trim()
    .regex(/^(\d{4})?$/, "Postal codes have 4 digits")
    .optional()
    .transform((v) => (v ? v : undefined)),
});

export type ShippingAddress = z.infer<typeof shippingAddressSchema>;

export const deliveryZoneSchema = z.enum(DeliveryZone, { error: "Choose a delivery area" });

export type CheckoutTotals = { subtotalMinor: number; deliveryFeeMinor: number; totalMinor: number };

export function checkoutTotals(lineTotalsMinor: readonly number[], zone: DeliveryZone): CheckoutTotals {
  const subtotalMinor = lineTotalsMinor.reduce((sum, v) => sum + v, 0);
  const deliveryFeeMinor = subtotalMinor > 0 ? DELIVERY_FEES_MINOR[zone] : 0;
  return { subtotalMinor, deliveryFeeMinor, totalMinor: subtotalMinor + deliveryFeeMinor };
}
