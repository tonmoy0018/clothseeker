import type { WorkerEnv } from "@/lib/env/schema";

import { CloudflareImage } from "./cloudflare";
import { FakeImage, FakePlanner } from "./fake";
import { GeminiPlanner } from "./gemini";
import type { AiProviders } from "./types";

// Picks the AI providers from the worker's environment. Only the worker calls this.

type ProviderEnv = Pick<
  WorkerEnv,
  | "PLANNER_PROVIDER"
  | "IMAGE_PROVIDER"
  | "GEMINI_API_KEY"
  | "GEMINI_MODEL"
  | "CLOUDFLARE_ACCOUNT_ID"
  | "CLOUDFLARE_API_TOKEN"
  | "CLOUDFLARE_IMAGE_MODEL"
  | "AI_FAKE_DELAY_MS"
>;

export class AiConfigError extends Error {
  override readonly name = "AiConfigError";
}

export function getAiProviders(env: ProviderEnv): AiProviders {
  let planner;
  if (env.PLANNER_PROVIDER === "gemini") {
    if (!env.GEMINI_API_KEY) {
      throw new AiConfigError("GEMINI_API_KEY is required when PLANNER_PROVIDER=gemini");
    }
    planner = new GeminiPlanner({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL });
  } else {
    planner = new FakePlanner(env.AI_FAKE_DELAY_MS);
  }

  let image;
  if (env.IMAGE_PROVIDER === "cloudflare") {
    if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
      throw new AiConfigError("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required when IMAGE_PROVIDER=cloudflare");
    }
    image = new CloudflareImage({ accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN, model: env.CLOUDFLARE_IMAGE_MODEL });
  } else {
    image = new FakeImage(env.AI_FAKE_DELAY_MS);
  }

  return { planner, image };
}
