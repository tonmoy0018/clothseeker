import type { DecorationId } from "@/lib/catalog/decorations";
import type { FontId } from "@/lib/catalog/fonts";
import type { PatternId } from "@/lib/catalog/patterns";
import type { GarmentType, GarmentTypeInfo, StyleGroup } from "@/lib/catalog/garment-types";

// Provider interfaces. Only the worker calls providers; the app only queues jobs (lib/ai/jobs.ts).
// Implementations (lib/ai/providers): fake.ts (default, deterministic), gemini.ts and planner-local.ts
// (planner), cloudflare.ts (images), tryon-hf.ts and tryon-local.ts (try-on).

export type ProviderImage = { data: Buffer; mimeType: "image/webp" | "image/png" | "image/jpeg" };

/** What the template allows, in the vocabulary the planner must answer in. */
export type PlanConstraints = {
  dressName: string;
  /** What kind of garment it is: decides which style groups exist and how prompts describe it. */
  garmentType: GarmentType;
  regions: { id: string; label: string }[];
  colors: { name: string; hex: string }[];
  patterns: PatternId[];
  fonts: FontId[];
  /** Built-in decorations (preferred over drawn motifs). */
  decorations: { id: DecorationId; label: string }[];
  /** Where items can go; sizes in cm. */
  areas: { id: string; label: string; side: "front" | "back"; widthCm: number; heightCm: number }[];
  styleOptions: Partial<Record<StyleGroup, { id: string; label: string }[]>>;
  /** False when the template has no placement area, so text and motifs can't be placed. */
  layersAllowed: boolean;
};

/** A design described in the planner's vocabulary (colors, patterns, style choices and the items on it). */
export type PlanSummary = {
  parts: { regionId: string; color: string; pattern: { id: string; color: string } | null }[];
  styleOptions: Partial<Record<StyleGroup, string>>;
  /** Text, decorations and pictures on the design; `byAi` ones may be replaced or removed by the planner. */
  items: { kind: "text" | "decoration" | "image" | "motif"; what: string; area: string; byAi: boolean }[];
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

/** Whether a customer photo can be used for try-on (all must be true). */
export type TryOnPhotoCheck = { onePerson: boolean; facingForward: boolean; goodLight: boolean; bodyVisible: boolean };

/** A live, customizable dress the planner may choose, in its own vocabulary. */
export type DressCandidate = {
  productId: string;
  name: string;
  category: string;
  description: string;
  garmentType: GarmentType;
  colors: { name: string; hex: string }[];
  patterns: PatternId[];
  styleOptions: Partial<Record<StyleGroup, { id: string; label: string }[]>>;
};

export type DressMatchRequest = {
  /** "photo": the customer's dress photo; "description": their words (untrusted, passed as data). */
  mode: "photo" | "description";
  image: ProviderImage | null;
  description: string | null;
  candidates: DressCandidate[];
  seed: string;
};

export interface PlannerProvider {
  readonly name: string;
  /** Looks for clothing brand logos in customer photos. */
  detectBrandLogos(images: ProviderImage[], signal: AbortSignal): Promise<BrandLogoCheck>;
  /** Returns raw JSON. It is NEVER trusted: lib/ai/plan.ts validates it and fits it to the template. */
  planDesign(request: PlanRequest, signal: AbortSignal): Promise<unknown>;
  /** Picks the closest dress and its main colors. Raw JSON, validated by lib/ai/match.ts. */
  matchDress(request: DressMatchRequest, signal: AbortSignal): Promise<unknown>;
  /**
   * Reads a customer's own garment photo: what it is, where it is, its style, colours and details.
   * Raw JSON, validated by lib/own-dress/read.ts (never trusted).
   */
  readGarment(image: ProviderImage, signal: AbortSignal): Promise<unknown>;
  /** Releases what it holds (the local model's process) when the worker stops. */
  close?(): void;
}

export type MotifRequest = { prompt: string; color: string; seed: number };

export interface ImageProvider {
  readonly name: string;
  /** A single decorative motif (PNG/JPEG/WebP bytes), ideally on a plain white or transparent background. */
  generateMotif(request: MotifRequest, signal: AbortSignal): Promise<Buffer>;
}

export type TryOnRequest = {
  /** The customer's photo (re-encoded, metadata stripped). */
  person: ProviderImage;
  /** The garment on a plain white 3:4 canvas, like a catalog product shot. */
  garment: ProviderImage;
  /** What kind of garment it is, in try-on models' terms (lib/catalog/garment-types.ts). */
  category: GarmentTypeInfo["tryOnCategory"];
  /** How far down it covers the body (used by the local try-on's mask). */
  reach?: GarmentTypeInfo["tryOnReach"];
  /**
   * How the chosen size fits this person (lib/fit/fit.ts): `width` 1 = as made for them, more is loose,
   * less tight; `hemLevel` = hem height above the floor as a share of their height (null = unknown).
   */
  fit?: { width: number; hemLevel: number | null };
  /** A short description of the garment from catalogue words (lib/tryon/describe.ts), when known. */
  description?: string;
};

export interface TryOnProvider {
  readonly name: string;
  /** Returns the person wearing the garment (image bytes, untrusted until re-encoded). */
  tryOn(request: TryOnRequest, signal: AbortSignal): Promise<Buffer>;
  /** Releases what it holds (the local model's process) when the worker stops. */
  close?(): void;
}

/** Checks a try-on photo: one person, facing forward, good light, body visible. */
export interface TryOnPhotoChecker {
  readonly name: string;
  checkTryOnPhoto(image: ProviderImage, signal: AbortSignal): Promise<TryOnPhotoCheck>;
}

/** Turns a customer's own garment photo into a clean product shot of the same garment (lib/own-dress). */
export interface GarmentShotProvider {
  readonly name: string;
  /** The product shot (image bytes, untrusted until re-encoded), or null when the model can't or won't (quota, refusal). */
  productShot(image: ProviderImage, signal: AbortSignal): Promise<Buffer | null>;
}

/** Turns a customer's drawing of a garment into a realistic photo of it (their own dress from a sketch). */
export interface SketchRenderer {
  readonly name: string;
  /**
   * A photo of the garment drawn in `sketch` (image bytes, untrusted until re-encoded), or null when the
   * model can't or won't (quota, refusal, nothing drawn). `note`: the customer's words on what it should
   * be made of (untrusted; providers pass it as a description, never as instructions). `variant`: which of
   * several renderings this is (real models differ by themselves; the fake shades each a little apart).
   */
  renderSketch(sketch: ProviderImage, note: string | null, signal: AbortSignal, variant?: number): Promise<Buffer | null>;
}

/** Turns a picture of a garment into a 3D model of it, for the 3D view (lib/model3d). */
export interface GarmentModelProvider {
  readonly name: string;
  /**
   * A GLB model (bytes, untrusted until checked by `checkGlb`) of the garment in `garment`: a PNG of the
   * garment alone, its backdrop transparent. The front follows the picture; the back and sides are the
   * model's guess.
   */
  buildModel(garment: ProviderImage, signal: AbortSignal): Promise<Buffer>;
  close?(): void;
}

/**
 * `garmentShot` is optional: without it, customers' own garments are cut out of their photos as they are.
 * Without `sketch`, a customer's drawing can't become a garment (the job fails with SKETCH_NOT_RENDERED).
 * Without `garmentModel`, there's no 3D view (its jobs fail with NOT_AVAILABLE).
 */
export type AiProviders = {
  planner: PlannerProvider;
  image: ImageProvider;
  tryOn: TryOnProvider;
  photoCheck: TryOnPhotoChecker;
  garmentShot?: GarmentShotProvider;
  sketch?: SketchRenderer;
  garmentModel?: GarmentModelProvider;
};
