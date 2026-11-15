import type { WorkerEnv } from "@/lib/env/schema";

import { CloudflareGarmentShot, CloudflareImage, CloudflareSketch } from "./providers/cloudflare";
import { FakeGarmentModel, FakeImage, FakePhotoChecker, FakePlanner, FakeSketch, FakeTryOn } from "./providers/fake";
import { GeminiGarmentShot, GeminiPlanner, GeminiSketch } from "./providers/gemini";
import { LlamaServerProcess } from "./providers/llama-server";
import { findLlamaServer, localLlmPaths, localLlmReady } from "./providers/local-llm-setup";
import { ModelSlot } from "./providers/model-slot";
import { LocalGarmentModel, TripoSrProcess } from "./providers/model3d-local";
import { local3dPaths, local3dReady } from "./providers/model3d-local-setup";
import { LocalPhotoChecker } from "./providers/photo-check-local";
import { FallbackPlanner } from "./providers/planner-fallback";
import { LocalPlanner } from "./providers/planner-local";
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
  | "PLANNER_FALLBACK"
  | "LOCAL_LLM_DIR"
  | "LLAMA_SERVER_BIN"
  | "LOCAL_LLM_CONTEXT"
  | "GARMENT_SHOT_PROVIDER"
  | "GEMINI_IMAGE_MODEL"
  | "CLOUDFLARE_ACCOUNT_ID"
  | "CLOUDFLARE_API_TOKEN"
  | "CLOUDFLARE_IMAGE_MODEL"
  | "CLOUDFLARE_FALLBACK_IMAGE_MODELS"
  | "CLOUDFLARE_SHOT_MODEL"
  | "SKETCH_PROVIDER"
  | "CLOUDFLARE_SKETCH_MODEL"
  | "AI_FAKE_DELAY_MS"
  | "TRYON_PROVIDER"
  | "HF_TOKEN"
  | "TRYON_SPACES"
  | "LOCAL_TRYON_DIR"
  | "LOCAL_TRYON_STEPS"
  | "LOCAL_TRYON_SAMPLER"
  | "LOCAL_TRYON_GUIDED"
  | "LOCAL_TRYON_WIDTH"
  | "MODEL3D_PROVIDER"
  | "LOCAL_3D_DIR"
>;

export class AiConfigError extends Error {
  override readonly name = "AiConfigError";
}

/** Whether the planner model on this machine may be used (on its own, or standing in for the hosted one). */
export function usesLocalPlanner(env: Pick<ProviderEnv, "PLANNER_PROVIDER" | "PLANNER_FALLBACK">): boolean {
  return env.PLANNER_PROVIDER === "local" || (env.PLANNER_PROVIDER === "gemini" && env.PLANNER_FALLBACK === "local");
}

function localPlanner(env: ProviderEnv, slot: ModelSlot): LocalPlanner {
  const paths = localLlmPaths(env.LOCAL_LLM_DIR);
  if (!localLlmReady(paths)) {
    throw new AiConfigError("The local planner model isn't set up: run `pnpm llm:setup` (needed when PLANNER_PROVIDER=local or PLANNER_FALLBACK=local)");
  }
  const bin = findLlamaServer(env.LLAMA_SERVER_BIN);
  if (!bin) {
    throw new AiConfigError("llama-server wasn't found: run `brew install llama.cpp` or set LLAMA_SERVER_BIN (needed for the local planner)");
  }
  return new LocalPlanner({ server: new LlamaServerProcess({ bin, model: paths.model, mmproj: paths.mmproj, contextTokens: env.LOCAL_LLM_CONTEXT, slot }) });
}

export function getAiProviders(env: ProviderEnv, onPlannerFallback?: (task: string) => void): AiProviders {
  // The big local models (planner, try-on) take turns in the Mac's memory.
  const slot = new ModelSlot();

  let planner;
  if (env.PLANNER_PROVIDER === "local") {
    planner = localPlanner(env, slot);
  } else if (env.PLANNER_PROVIDER === "gemini") {
    if (!env.GEMINI_API_KEY) {
      throw new AiConfigError("GEMINI_API_KEY is required when PLANNER_PROVIDER=gemini");
    }
    const gemini = new GeminiPlanner({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL, fallbackModels: env.GEMINI_FALLBACK_MODELS });
    planner = env.PLANNER_FALLBACK === "local" ? new FallbackPlanner(gemini, localPlanner(env, slot), onPlannerFallback) : gemini;
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
      const runner = new CatVtonProcess({ python: paths.python, weights: paths.weights, slot });
      tryOn = new LocalTryOn({
        runner,
        body: new NodeVision(),
        steps: env.LOCAL_TRYON_STEPS,
        width: env.LOCAL_TRYON_WIDTH,
        sampler: env.LOCAL_TRYON_SAMPLER,
        guided: env.LOCAL_TRYON_GUIDED,
      });
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

  // A customer's drawing made into a realistic photo of the garment: FLUX.2 on Cloudflare's free allowance,
  // Gemini's image model (billed per image), or the fake that fills the drawn outline with a colour.
  let sketch;
  if (env.SKETCH_PROVIDER === "cloudflare") {
    if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
      throw new AiConfigError("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required when SKETCH_PROVIDER=cloudflare");
    }
    sketch = new CloudflareSketch({ accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN, model: env.CLOUDFLARE_SKETCH_MODEL });
  } else if (env.SKETCH_PROVIDER === "gemini") {
    if (!env.GEMINI_API_KEY) {
      throw new AiConfigError("GEMINI_API_KEY is required when SKETCH_PROVIDER=gemini");
    }
    sketch = new GeminiSketch({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_IMAGE_MODEL });
  } else {
    sketch = new FakeSketch(env.AI_FAKE_DELAY_MS);
  }

  // The 3D view: TripoSR on this machine, or the fake that bulges the picture into a card.
  let garmentModel;
  if (env.MODEL3D_PROVIDER === "local") {
    const paths = local3dPaths(env.LOCAL_3D_DIR);
    if (!local3dReady(paths)) {
      throw new AiConfigError("The local 3D model isn't set up: run `pnpm model3d:setup` (needed when MODEL3D_PROVIDER=local)");
    }
    garmentModel = new LocalGarmentModel(new TripoSrProcess({ python: paths.python, weights: paths.weights, source: paths.source, slot }));
  } else {
    garmentModel = new FakeGarmentModel(env.AI_FAKE_DELAY_MS);
  }

  return { planner, image, tryOn, photoCheck, sketch, garmentModel, ...(garmentShot ? { garmentShot } : {}) };
}
