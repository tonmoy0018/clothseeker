import { z } from "zod";

// Pure rules for decoration cut-outs, shared by the browser and the server. No Node or database imports.

/** Cut-outs per customer per Dhaka day (each strength or colour change makes a new one). */
export const CUTOUT_DAILY_LIMIT = 30;
export const CUTOUT_LIMIT_MESSAGE = `You've made today's ${CUTOUT_DAILY_LIMIT} cut-outs. They reset at midnight (Dhaka time); your earlier cut-outs are still under "Your cut-outs".`;
/** How much fabric is removed by default (0 keeps the most, 1 removes the most). */
export const DEFAULT_STRENGTH = 0.4;
/** Below this, a cut-out is a reference for the team to recreate, not a file to print. */
export const PRINTABLE_DPI = 150;

const fraction = z.number().min(0).max(1);
const hex = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i)
  .transform((v) => v.toLowerCase());

export const cutoutBoxSchema = z
  .object({ x: fraction, y: fraction, w: fraction.positive(), h: fraction.positive() })
  .refine((b) => b.x + b.w <= 1.0001 && b.y + b.h <= 1.0001, "The box must be inside the photo");

export const cutoutInputSchema = z.object({
  /** The ClothSeeker dress to take the decoration from, and which of its photos. */
  productId: z.uuid(),
  imageIndex: z.number().int().min(0).max(19),
  box: cutoutBoxSchema,
  strength: fraction,
  /** New colours for the cut-out's main colours, in palette order (null keeps one). */
  swaps: z.array(hex.nullable()).max(4).default([]),
  /** The product being designed: swapped colours must be among its template's colours. */
  designProductId: z.uuid(),
});
export type CutoutInput = z.input<typeof cutoutInputSchema>;

/** What's stored in DecorationCutout.settings. */
export const cutoutSettingsSchema = z.object({ box: cutoutBoxSchema, strength: fraction, swaps: z.array(hex.nullable()).max(4) });
export type CutoutSettings = z.infer<typeof cutoutSettingsSchema>;

/** Resolution of an image fitted (kept in proportion) into a box of `boxCm` when printed. */
export function printDpi(pixels: { width: number; height: number }, boxCm: { width: number; height: number }): number {
  const cmPerPixel = Math.min(boxCm.width / Math.max(1, pixels.width), boxCm.height / Math.max(1, pixels.height));
  return Math.round(2.54 / Math.max(1e-6, cmPerPixel));
}
