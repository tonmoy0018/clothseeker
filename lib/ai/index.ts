import type { WorkerEnv } from "@/lib/env/schema";

import { CloudflareGarmentShot, CloudflareImage } from "./providers/cloudflare";
import { FakeImage, FakePhotoChecker, FakePlanner, FakeTryOn } from "./providers/fake";
import { GeminiGarmentShot, GeminiPlanner } from "./providers/gemini";
import { LocalPhotoChecker } from "./providers/photo-check-local";
import { HuggingFaceTryOn } from "./providers/tryon-hf";
import { CatVtonProcess, LocalTryOn } from "./providers/tryon-local";
import { localTryOnPaths, localTryOnReady } from "./providers/tryon-local-setup";
import type { AiProviders } from "./types";
import { NodeVision, nodeModelsPresent } from "@/lib/vision/runtime/node-vision";

// Picks the AI providers from the worker's environment. Only the worker calls this.

type ProviderEnv = Pick<
  WorkerEnv,
  | "PLANNER_PROVIDER"
  | "IMAGE_PROVIDER"
  | "GEMINI_API_KEY"
  | "GEMINI_MODEL"
  | "GEMINI_FALLBACK_MODELS"
  | "GARMENT_SHOT_PROVIDER"
  | "GEMINI_IMAGE_MODEL"
  | "CLOUDFLARE_ACCOUNT_ID"
  | "CLOUDFLARE_API_TOKEN"
  | "CLOUDFLARE_IMAGE_MODEL"
  | "CLOUDFLARE_FALLBACK_IMAGE_MODELS"
  | "CLOUDFLARE_SHOT_MODEL"
  | "AI_FAKE_DELAY_MS"
  | "TRYON_PROVIDER"
  | "HF_TOKEN"
  | "TRYON_SPACES"
  | "LOCAL_TRYON_DIR"
  | "LOCAL_TRYON_STEPS"
  | "LOCAL_TRYON_WIDTH"
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
    planner = new GeminiPlanner({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL, fallbackModels: env.GEMINI_FALLBACK_MODELS });
  } else {
    planner = new FakePlanner(env.AI_FAKE_DELAY_MS);
  }

  let image;
  if (env.IMAGE_PROVIDER === "cloudflare") {
    if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
      throw new AiConfigError("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required when IMAGE_PROVIDER=cloudflare");
    }
    image = new CloudflareImage({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: env.CLOUDFLARE_API_TOKEN,
      model: env.CLOUDFLARE_IMAGE_MODEL,
      fallbackModels: env.CLOUDFLARE_FALLBACK_IMAGE_MODELS,
    });
  } else {
    image = new FakeImage(env.AI_FAKE_DELAY_MS);
  }

  // Real try-ons get the real photo check: the on-device models, run here in the worker.
  let tryOn;
  let photoCheck;
  if (env.TRYON_PROVIDER === "huggingface" || env.TRYON_PROVIDER === "local") {
    if (!nodeModelsPresent()) {
      throw new AiConfigError(`The on-device vision models are missing: run \`pnpm vision:fetch\` (needed when TRYON_PROVIDER=${env.TRYON_PROVIDER})`);
    }
    if (env.TRYON_PROVIDER === "local") {
      const paths = localTryOnPaths(env.LOCAL_TRYON_DIR);
      if (!localTryOnReady(paths)) {
        throw new AiConfigError("The local try-on model isn't set up: run `pnpm tryon:setup` (needed when TRYON_PROVIDER=local)");
      }
      const runner = new CatVtonProcess({ python: paths.python, weights: paths.weights });
      tryOn = new LocalTryOn({ runner, body: new NodeVision(), steps: env.LOCAL_TRYON_STEPS, width: env.LOCAL_TRYON_WIDTH });
    } else {
      tryOn = new HuggingFaceTryOn({ spaces: env.TRYON_SPACES, token: env.HF_TOKEN });
    }
    photoCheck = new LocalPhotoChecker();
  } else {
    tryOn = new FakeTryOn(env.AI_FAKE_DELAY_MS);
    photoCheck = new FakePhotoChecker(env.AI_FAKE_DELAY_MS);
  }

  // Clean product shots of customers' own garments (optional): FLUX.2 on Cloudflare's free allowance, or
  // Gemini's image model (billed per image; free keys are refused).
  let garmentShot;
  if (env.GARMENT_SHOT_PROVIDER === "cloudflare") {
    if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
      throw new AiConfigError("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required when GARMENT_SHOT_PROVIDER=cloudflare");
    }
    garmentShot = new CloudflareGarmentShot({ accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN, model: env.CLOUDFLARE_SHOT_MODEL });
  } else if (env.GARMENT_SHOT_PROVIDER === "gemini") {
    if (!env.GEMINI_API_KEY) {
      throw new AiConfigError("GEMINI_API_KEY is required when GARMENT_SHOT_PROVIDER=gemini");
    }
    garmentShot = new GeminiGarmentShot({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_IMAGE_MODEL });
  }

  return { planner, image, tryOn, photoCheck, ...(garmentShot ? { garmentShot } : {}) };
}
