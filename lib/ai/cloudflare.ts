import { z } from "zod";

import { AiProviderError } from "./errors";
import { providerFetch, type FetchLike } from "./http";
import type { ImageProvider, MotifRequest } from "./types";

// Cloudflare Workers AI text-to-image (default model: FLUX.1 [schnell], free daily allowance).
// The motif is asked for on a plain white background; the pipeline knocks the white out so only
// the motif is printed on the dress.

export const DEFAULT_CLOUDFLARE_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

export type CloudflareOptions = { accountId: string; apiToken: string; model: string; fetch?: FetchLike };

/** The prompt sent for a motif. The planner's words are kept short and wrapped in fixed guidance. */
export function motifPrompt(request: MotifRequest): string {
  const subject = request.prompt.replace(/[^\p{L}\p{N} ,.'-]/gu, " ").slice(0, 160).trim();
  return `A single ${subject}, flat vector illustration in the color ${request.color}, centred, isolated on a plain pure white background, no text, no letters, no logos, no brand marks.`;
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
    const response = await providerFetch(this.fetchImpl, "cloudflare", url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiToken}` },
      body: JSON.stringify({ prompt: motifPrompt(request), seed: request.seed, steps: 4 }),
      signal,
    });
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
