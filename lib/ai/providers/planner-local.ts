import sharp from "sharp";
import { z } from "zod";

import { AiProviderError } from "../errors";
import type { BrandLogoCheck, DressMatchRequest, PlannerProvider, PlanRequest, ProviderImage } from "../types";
import {
  LOGO_REQUEST_TEXT,
  LOGO_SCHEMA,
  LOGO_SYSTEM,
  MATCH_SYSTEM,
  matchRequestText,
  matchResponseSchema,
  PLAN_SYSTEM,
  planRequestText,
  planResponseSchema,
  READ_REQUEST_TEXT,
  READ_SCHEMA,
  READ_SYSTEM,
  type JsonSchema,
} from "./gemini";
import { providerFetch, type FetchLike } from "./http";
import { stripNulls, toJsonSchema } from "./json-schema";

// The planner on our own machine (PLANNER_PROVIDER=local): an open vision-language model in llama.cpp's
// server (llama-server.ts), so no request or photo leaves the Mac and there's no daily allowance. It
// does the same four tasks as the Gemini planner, with the same instructions and the same answer
// shapes; the shapes are enforced by a grammar, so the answer is always valid JSON of the right form.
// It is a much smaller model than Gemini's: expect it to follow involved requests less exactly.
// Setup: `brew install llama.cpp`, then `pnpm llm:setup` (docs/developers/ai-pipelines.md).
//
// Prompt-injection hygiene is the same as for Gemini: fixed system instructions, the customer's words
// and photos as data in the user turn, and an answer that is re-validated and fitted to the template.

/** The model server (LlamaServerProcess; a fake in tests). */
export type ChatServer = {
  baseUrl(signal: AbortSignal): Promise<string>;
  release(): void;
  close(): void;
};

/** How much the model read and wrote for one answer, and how fast (counts and speeds only, never text). */
export type LocalPlannerStats = { promptTokens: number; outputTokens: number; promptPerSecond: number; outputPerSecond: number };

export type LocalPlannerOptions = {
  server: ChatServer;
  fetch?: FetchLike;
  temperature?: number;
  onStats?: (stats: LocalPlannerStats) => void;
};

/** Photos are shrunk to this before the model sees them: enough to read a garment, few enough tokens. */
const IMAGE_SIDE = 768;

/**
 * Added to every task's instructions: the model writes about 12 tokens a second on the Mac, so line
 * breaks and indentation (a fifth of a pretty-printed answer) are time the customer waits.
 */
const COMPACT = "Write the JSON compactly on one line, with no line breaks or indentation.";

/** Far above a normal answer (about 1,000 tokens); stops a rambling model quickly. */
const MAX_OUTPUT_TOKENS = 3072;

const responseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullish() }), finish_reason: z.string().nullish() })).min(1),
  timings: z.object({ prompt_n: z.number(), predicted_n: z.number(), prompt_per_second: z.number(), predicted_per_second: z.number() }).partial().optional(),
});

async function imagePart(image: ProviderImage) {
  const jpeg = await sharp(image.data).rotate().resize(IMAGE_SIDE, IMAGE_SIDE, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 88 }).toBuffer();
  return { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } };
}

export class LocalPlanner implements PlannerProvider {
  readonly name = "local";
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: LocalPlannerOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  close(): void {
    this.options.server.close();
  }

  async detectBrandLogos(images: ProviderImage[], signal: AbortSignal): Promise<BrandLogoCheck> {
    if (images.length === 0) {
      return { detected: false };
    }
    const raw = await this.generate(LOGO_SYSTEM, LOGO_REQUEST_TEXT, images, LOGO_SCHEMA, 0, signal);
    const parsed = z.object({ detected: z.boolean(), brand: z.string().nullish() }).safeParse(raw);
    if (!parsed.success) {
      throw new AiProviderError("local planner logo check returned an unexpected shape", true, "INVALID_PLAN");
    }
    return { detected: parsed.data.detected, label: parsed.data.brand ?? undefined };
  }

  matchDress(request: DressMatchRequest, signal: AbortSignal): Promise<unknown> {
    return this.generate(MATCH_SYSTEM, matchRequestText(request), request.image ? [request.image] : [], matchResponseSchema(request), 0.2, signal);
  }

  readGarment(image: ProviderImage, signal: AbortSignal): Promise<unknown> {
    return this.generate(READ_SYSTEM, READ_REQUEST_TEXT, [image], READ_SCHEMA, 0, signal);
  }

  planDesign(request: PlanRequest, signal: AbortSignal): Promise<unknown> {
    return this.generate(PLAN_SYSTEM, planRequestText(request), request.images, planResponseSchema(request.constraints), this.options.temperature ?? 0.6, signal);
  }

  private async generate(system: string, text: string, images: ProviderImage[], schema: JsonSchema, temperature: number, signal: AbortSignal): Promise<unknown> {
    const { server } = this.options;
    const content = [{ type: "text", text }, ...(await Promise.all(images.map(imagePart)))];
    const base = await server.baseUrl(signal);
    try {
      const response = await providerFetch(this.fetchImpl, "local planner", `${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [
            { role: "system", content: `${system}\n${COMPACT}` },
            { role: "user", content },
          ],
          temperature,
          max_tokens: MAX_OUTPUT_TOKENS,
          // The grammar made from this schema is what keeps the answer in shape.
          response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema: toJsonSchema(schema) } },
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal,
      });
      const body = responseSchema.safeParse(await response.json().catch(() => null));
      if (!body.success) {
        throw new AiProviderError("local planner returned an unreadable response", true, "INVALID_PLAN");
      }
      const { timings } = body.data;
      if (timings) {
        this.options.onStats?.({
          promptTokens: timings.prompt_n ?? 0,
          outputTokens: timings.predicted_n ?? 0,
          promptPerSecond: Math.round(timings.prompt_per_second ?? 0),
          outputPerSecond: Math.round((timings.predicted_per_second ?? 0) * 10) / 10,
        });
      }
      const choice = body.data.choices[0];
      if (!choice?.message.content || choice.finish_reason === "length") {
        throw new AiProviderError(`local planner returned no complete answer (${choice?.finish_reason ?? "none"})`, true, "INVALID_PLAN");
      }
      try {
        return stripNulls(JSON.parse(choice.message.content));
      } catch {
        throw new AiProviderError("local planner returned invalid JSON", true, "INVALID_PLAN");
      }
    } catch (error) {
      // A request that ran out of time leaves the model busy: stop it, the next request starts it afresh.
      if (signal.aborted) server.close();
      throw error;
    } finally {
      server.release();
    }
  }
}
