import { z } from "zod";

import { AiProviderError } from "./errors";
import { providerFetch, type FetchLike } from "./http";
import type { ImageProvider, MotifRequest } from "./types";

// Cloudflare Workers AI text-to-image (default model: FLUX.1 [schnell], free daily allowance).
// The motif is asked for on a plain white background; the pipeline knocks the white out so only
// the motif is printed on the dress. Its safety filter sometimes rejects harmless prompts (HTTP 400,
// "NSFW"); that counts as non-retryable and the round keeps the option without a motif. So does the free
// daily allowance running out (HTTP 429 with error code 4006): it only comes back at 00:00 UTC, so retrying
// the round would just fail it. Short rate limits (other 429s) still retry.

export const DEFAULT_CLOUDFLARE_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

export type CloudflareOptions = { accountId: string; apiToken: string; model: string; fetch?: FetchLike };

/** The prompt sent for a motif. The planner's words are kept short and wrapped in fixed guidance. */
export function motifPrompt(request: MotifRequest): string {
  const subject = request.prompt.replace(/[^\p{L}\p{N} ,.'-]/gu, " ").slice(0, 160).trim();
  return `A single ${subject}, flat vector illustration in the color ${request.color}, centred, isolated on a plain pure white background, no text, no letters, no logos, no brand marks.`;
}

/** Cloudflare's "daily free allocation used up" error code. */
const DAILY_ALLOWANCE_USED = 4006;
const errorBody = z.object({ errors: z.array(z.object({ code: z.number() })) });

/** Whether a 429 is the daily allowance (not a short rate limit). Reads only error codes, never messages. */
async function isDailyAllowanceUsed(response: Response): Promise<boolean> {
  const body = errorBody.safeParse(await response.json().catch(() => null));
  return body.success && body.data.errors.some((e) => e.code === DAILY_ALLOWANCE_USED);
}

const jsonResponse = z.object({ success: z.boolean().optional(), result: z.object({ image: z.string().min(1) }) });

export class CloudflareImage implements ImageProvider {
  readonly name = "cloudflare";
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: CloudflareOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async generateMotif(request: MotifRequest, signal: AbortSignal): Promise<Buffer> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.options.accountId)}/ai/run/${this.options.model}`;
    let allowanceUsed = false;
    const checked: FetchLike = async (input, init) => {
      const response = await this.fetchImpl(input, init);
      if (response.status === 429) allowanceUsed = await isDailyAllowanceUsed(response.clone());
      return response;
    };
    let response: Response;
    try {
      response = await providerFetch(checked, "cloudflare", url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiToken}` },
        // FLUX.1 schnell on Workers AI rejects unknown inputs (including `seed`), so only prompt + steps.
        body: JSON.stringify({ prompt: motifPrompt(request), steps: 4 }),
        signal,
      });
    } catch (error) {
      if (allowanceUsed) throw new AiProviderError("cloudflare daily allowance used up", false, "PROVIDER", 429);
      throw error;
    }
    // FLUX answers JSON with a base64 image; some other models stream the image bytes directly.
    if ((response.headers.get("content-type") ?? "").startsWith("image/")) {
      return Buffer.from(await response.arrayBuffer());
    }
    const body = jsonResponse.safeParse(await response.json().catch(() => null));
    if (!body.success || body.data.success === false) {
      throw new AiProviderError("cloudflare returned no image", true);
    }
    return Buffer.from(body.data.result.image, "base64");
  }
}
