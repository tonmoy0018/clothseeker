import type { FontId } from "@/lib/catalog/fonts";
import type { PatternId } from "@/lib/catalog/patterns";
import type { StyleGroup } from "@/types/template";

// Provider interfaces. Only the worker calls providers; the app only queues jobs (lib/ai/jobs.ts).
// Implementations: fake.ts (default, deterministic), gemini.ts (planner), cloudflare.ts (images).

export type ProviderImage = { data: Buffer; mimeType: "image/webp" | "image/png" | "image/jpeg" };

/** What the template allows, in the vocabulary the planner must answer in. */
export type PlanConstraints = {
  dressName: string;
  regions: { id: string; label: string }[];
  colors: { name: string; hex: string }[];
  patterns: PatternId[];
  fonts: FontId[];
  styleOptions: Record<StyleGroup, { id: string; label: string }[]>;
  /** False when the template has no placement area, so text and motifs can't be placed. */
  layersAllowed: boolean;
};

/** A design described in the planner's vocabulary (colors, patterns and style choices). */
export type PlanSummary = {
  parts: { regionId: string; color: string; pattern: { id: string; color: string } | null }[];
  styleOptions: Record<StyleGroup, string>;
  text: string | null;
};

export type PlanRequest = {
  /** The customer's words. Untrusted: providers must pass it as data, never as instructions. */
  instruction: string;
  images: ProviderImage[];
  constraints: PlanConstraints;
  current: PlanSummary;
  /** Set for follow-ups such as "like option 2 but darker". */
  reference: PlanSummary | null;
  /** Stable per request; lets deterministic providers vary between "Generate again" rounds. */
  seed: string;
};

export type BrandLogoCheck = { detected: boolean; label?: string };

export interface PlannerProvider {
  readonly name: string;
  /** Looks for clothing brand logos in customer photos. */
  detectBrandLogos(images: ProviderImage[], signal: AbortSignal): Promise<BrandLogoCheck>;
  /** Returns raw JSON. It is NEVER trusted: lib/ai/plan.ts validates it and fits it to the template. */
  planDesign(request: PlanRequest, signal: AbortSignal): Promise<unknown>;
}

export type MotifRequest = { prompt: string; color: string; seed: number };

export interface ImageProvider {
  readonly name: string;
  /** A single decorative motif (PNG/JPEG/WebP bytes), ideally on a plain white or transparent background. */
  generateMotif(request: MotifRequest, signal: AbortSignal): Promise<Buffer>;
}

export type AiProviders = { planner: PlannerProvider; image: ImageProvider };
