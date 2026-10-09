import { z } from "zod";

import { canonicalJson } from "@/lib/ai/canonical";
import type { DesignSpec } from "@/types/design-spec";

// Pure try-on rules shared by the browser and the server. No Node or database imports.

/** Free GPU time is scarce and shared by the whole store, so try-ons have their own small limit. */
export const TRYON_DAILY_LIMIT = 5;
export const TRYON_QUOTA_MESSAGE = `You've used today's ${TRYON_DAILY_LIMIT} try-ons. They reset at midnight (Dhaka time).`;

/** Unsaved photos and results are deleted this long after they were made. */
export const TRYON_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Shown before any upload. The upload is refused unless the customer agrees. */
export const TRYON_CONSENT_POINTS = [
  "Your photo is used only to show this dress on you.",
  "To make the preview, your photo is sent to a third-party AI service (a public Hugging Face Space).",
  "ClothSeeker never uses your photos to train AI.",
  "Unless you choose to save them, your photo and try-on results are deleted after 24 hours. You can delete them yourself at any time.",
] as const;

export const consentSchema = z.literal("yes", { error: "Please agree to the try-on terms before uploading a photo." });

/**
 * A stable signature of how a design looks, for "your design changed since this try-on".
 * Size isn't part of it: it doesn't change what the preview shows.
 */
export function designSignature(spec: Pick<DesignSpec, "parts" | "styleOptions" | "layers">): string {
  return `d-${fnv1a(canonicalJson({ parts: spec.parts, styleOptions: spec.styleOptions, layers: spec.layers }))}`;
}

export function productSignature(productId: string, imageKey: string): string {
  return `p-${fnv1a(`${productId}:${imageKey}`)}`;
}

/** True when the design on screen no longer matches what was tried on. Never triggers a rerun by itself. */
export function isTryOnStale(triedSignature: string, current: Pick<DesignSpec, "parts" | "styleOptions" | "layers">): boolean {
  return triedSignature !== designSignature(current);
}

/** 64-bit FNV-1a as hex (two 32-bit halves). Not cryptographic; only for change detection. */
function fnv1a(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193 + 0x100) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

export type PhotoShape = { width: number; height: number; meanBrightness: number };

/** Cheap checks done at upload, before anything is queued. Returns a friendly problem, or null. */
export function photoShapeProblem(photo: PhotoShape): string | null {
  if (photo.width > photo.height * 1.05) {
    return "Use a portrait (upright) photo that shows you from your shoulders to your knees.";
  }
  if (photo.meanBrightness < 45) {
    return "This photo is too dark. Try one taken in good light.";
  }
  if (photo.meanBrightness > 245) {
    return "This photo is too bright to see you clearly. Try another one.";
  }
  return null;
}
