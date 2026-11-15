import sharp from "sharp";
import { z } from "zod";

import { AiProviderError } from "../errors";
import { providerFetch, type FetchLike } from "./http";
import { sketchPrompt } from "../sketch";
import type { GarmentShotProvider, ImageProvider, MotifRequest, ProviderImage, SketchRenderer } from "../types";

// Cloudflare Workers AI images (free daily allowance of 10,000 neurons, shared by everything below).
//
// Motifs: FLUX.2 [klein] 4B first (about 104 neurons a picture, so roughly 95 a day): it keeps to the
// colour it's asked for, which FLUX.1 [schnell] (about 58 neurons) often doesn't, and its safety filter
// doesn't refuse harmless words such as "paisley teardrop". When it fails for any reason but the daily
// allowance, the next model is tried. The motif is asked for on a plain white background; the pipeline
// knocks the white out so only the motif is printed on the dress. A refusal (HTTP 400) by every model
// counts as non-retryable and the round keeps the option without a motif. So does the allowance running
// out (HTTP 429 with error code 4006): it only comes back at 00:00 UTC, and the other models draw on the
// same allowance, so retrying would just fail the round. Short rate limits (other 429s) still retry.
//
// Product shots (CloudflareGarmentShot): FLUX.2 [klein] also edits pictures, so it can turn a customer's
// photo of a garment into a clean studio shot of the same garment (about 125 neurons). The same goes for a
// customer's drawing of a garment (CloudflareSketch): it becomes a realistic photo of it.

export const DEFAULT_CLOUDFLARE_IMAGE_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
export const DEFAULT_CLOUDFLARE_FALLBACK_IMAGE_MODELS = ["@cf/black-forest-labs/flux-1-schnell"] as const;
export const DEFAULT_CLOUDFLARE_SHOT_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";

export type CloudflareOptions = {
  accountId: string;
  apiToken: string;
  model: string;
  /** Tried in order when a model fails (busy, refused the words, retired), but not when the daily allowance is used up. */
  fallbackModels?: readonly string[];
  fetch?: FetchLike;
};

/** The prompt sent for a motif. The planner's words are kept short and wrapped in fixed guidance. */
export function motifPrompt(request: MotifRequest): string {
  const subject = request.prompt.replace(/[^\p{L}\p{N} ,.'-]/gu, " ").slice(0, 160).trim();
  return `A single ${subject}, flat vector illustration in the color ${request.color}, centred, isolated on a plain pure white background, no text, no letters, no logos, no brand marks.`;
}

/** FLUX.2 models take a multipart form (they can be given pictures too); older ones take JSON. */
const takesForm = (model: string) => model.includes("/flux-2-");

/** Motifs are printed up to about 20 cm wide: 1024 px keeps them usable. */
const MOTIF_SIZE = 1024;

/** Cloudflare's "daily free allocation used up" error code. */
const DAILY_ALLOWANCE_USED = 4006;
const errorBody = z.object({ errors: z.array(z.object({ code: z.number() })) });

/** Whether a 429 is the daily allowance (not a short rate limit). Reads only error codes, never messages. */
async function isDailyAllowanceUsed(response: Response): Promise<boolean> {
  const body = errorBody.safeParse(await response.json().catch(() => null));
  return body.success && body.data.errors.some((e) => e.code === DAILY_ALLOWANCE_USED);
}

const jsonResponse = z.object({ success: z.boolean().optional(), result: z.object({ image: z.string().min(1).max(40_000_000) }) });

const runUrl = (accountId: string, model: string) => `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`;

/** FLUX answers JSON with a base64 image; some other models stream the image bytes directly. */
async function imageFrom(response: Response): Promise<Buffer> {
  if ((response.headers.get("content-type") ?? "").startsWith("image/")) {
    return Buffer.from(await response.arrayBuffer());
  }
  const body = jsonResponse.safeParse(await response.json().catch(() => null));
  if (!body.success || body.data.success === false) {
    throw new AiProviderError("cloudflare returned no image", true);
  }
  return Buffer.from(body.data.result.image, "base64");
}

export class CloudflareImage implements ImageProvider {
  readonly name = "cloudflare";
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: CloudflareOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async generateMotif(request: MotifRequest, signal: AbortSignal): Promise<Buffer> {
    const models = [...new Set([this.options.model, ...(this.options.fallbackModels ?? [])])];
    let lastError: unknown = null;
    for (const model of models) {
      try {
        return await this.generateWith(model, request, signal);
      } catch (error) {
        // The key is wrong for every model, and the allowance is shared by all of them.
        const final = !(error instanceof AiProviderError) || signal.aborted || error.status === 401 || error.status === 403 || (error.status === 429 && !error.retryable);
        if (final) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  private async generateWith(model: string, request: MotifRequest, signal: AbortSignal): Promise<Buffer> {
    let allowanceUsed = false;
    const checked: FetchLike = async (input, init) => {
      const response = await this.fetchImpl(input, init);
      if (response.status === 429) allowanceUsed = await isDailyAllowanceUsed(response.clone());
      return response;
    };
    const authorization = `Bearer ${this.options.apiToken}`;
    let init: RequestInit;
    if (takesForm(model)) {
      const form = new FormData();
      form.append("prompt", motifPrompt(request));
      form.append("width", String(MOTIF_SIZE));
      form.append("height", String(MOTIF_SIZE));
      init = { method: "POST", headers: { authorization }, body: form, signal };
    } else {
      // FLUX.1 schnell on Workers AI rejects unknown inputs (including `seed`), so only prompt + steps.
      init = { method: "POST", headers: { "content-type": "application/json", authorization }, body: JSON.stringify({ prompt: motifPrompt(request), steps: 4 }), signal };
    }
    let response: Response;
    try {
      response = await providerFetch(checked, "cloudflare", runUrl(this.options.accountId, model), init);
    } catch (error) {
      if (allowanceUsed) throw new AiProviderError("cloudflare daily allowance used up", false, "PROVIDER", 429);
      throw error;
    }
    return imageFrom(response);
  }
}

const SHOT_PROMPT = [
  "Turn this photo into a clean e-commerce product photo of the SAME main garment, for a tailor to make an exact copy.",
  "Keep everything about the garment exactly as it is: its cut, length, proportions, colours, fabric, print, seams, buttons, lacing, trims and details. Do not add, remove or redesign anything, and add no text or logos.",
  "Show only that garment, front view, centred, upright, filling most of the picture, worn by an invisible ghost mannequin so the neck opening is empty: no person, no skin, no visible mannequin, no hanger, no stand, no other clothes.",
  "Plain light grey studio background (#f1f0ed), soft even studio light, sharp, portrait 3:4.",
].join(" ");

/** The picture sent and the shot asked for: 3:4, the size the garment cut-out works at. */
const SHOT_INPUT_SIDE = 1024;
const SHOT_WIDTH = 768;
const SHOT_HEIGHT = 1024;

/** Sends a picture and an instruction to an image-editing model (FLUX.2 klein takes a multipart form). */
async function editPicture(fetchImpl: FetchLike, provider: string, accountId: string, apiToken: string, model: string, prompt: string, image: ProviderImage, signal: AbortSignal): Promise<Response> {
  const jpeg = await sharp(image.data).rotate().resize(SHOT_INPUT_SIDE, SHOT_INPUT_SIDE, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer();
  const form = new FormData();
  form.append("prompt", prompt);
  form.append("input_image_0", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "garment.jpg");
  form.append("width", String(SHOT_WIDTH));
  form.append("height", String(SHOT_HEIGHT));
  return providerFetch(fetchImpl, provider, runUrl(accountId, model), { method: "POST", headers: { authorization: `Bearer ${apiToken}` }, body: form, signal });
}

type EditOptions = { accountId: string; apiToken: string; model: string; fetch?: FetchLike };

/**
 * FLUX.2 [klein] on Workers AI, making a clean product shot of a customer's own garment from their photo
 * (lib/own-dress). It only helps: anything but a picture (the daily allowance used up, a refusal, an odd
 * answer) is "no shot", and the garment is cut out of the customer's photo instead. The photo is sent to
 * Cloudflare for this; it's re-encoded first, so nothing but its pixels leaves.
 */
export class CloudflareGarmentShot implements GarmentShotProvider {
  readonly name = "cloudflare";
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: EditOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async productShot(image: ProviderImage, signal: AbortSignal): Promise<Buffer | null> {
    const { accountId, apiToken, model } = this.options;
    let response: Response;
    try {
      response = await editPicture(this.fetchImpl, "cloudflare-shot", accountId, apiToken, model, SHOT_PROMPT, image, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      return null;
    }
    try {
      return await imageFrom(response);
    } catch {
      return null;
    }
  }
}

/**
 * FLUX.2 [klein] on Workers AI, turning a customer's drawing of a garment into a realistic photo of it
 * (lib/ai/sketch.ts). The drawing is needed, unlike a product shot: a busy service or a short rate limit is
 * retried (the error is thrown); a refusal or the daily allowance used up is "no picture" (null), which
 * ends the job with a message. The drawing is sent to Cloudflare, re-encoded so only its pixels leave.
 */
export class CloudflareSketch implements SketchRenderer {
  readonly name = "cloudflare";
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: EditOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async renderSketch(sketch: ProviderImage, note: string | null, signal: AbortSignal): Promise<Buffer | null> {
    const { accountId, apiToken, model } = this.options;
    let allowanceUsed = false;
    const checked: FetchLike = async (input, init) => {
      const response = await this.fetchImpl(input, init);
      if (response.status === 429) allowanceUsed = await isDailyAllowanceUsed(response.clone());
      return response;
    };
    let response: Response;
    try {
      response = await editPicture(checked, "cloudflare-sketch", accountId, apiToken, model, sketchPrompt(note), sketch, signal);
    } catch (error) {
      // Refused (HTTP 400, its safety filter) or out of today's allowance: trying again won't help today.
      if (!signal.aborted && error instanceof AiProviderError && (error.status === 400 || allowanceUsed)) return null;
      throw error;
    }
    try {
      return await imageFrom(response);
    } catch {
      return null;
    }
  }
}
