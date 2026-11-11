import { z } from "zod";

// Pure schemas + parser, shared by the app, the worker and scripts.
// Never import server-only modules here: the worker and tests run outside Next.js.

const httpUrl = z.url({ protocol: /^https?$/ });
const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });

/** Safe to expose to the browser. Every key must start with NEXT_PUBLIC_. */
export const clientEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: httpUrl,
  NEXT_PUBLIC_SUPABASE_URL: httpUrl,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
});

/** Server-only secrets. Never import these from client components. */
export const serverEnvSchema = clientEnvSchema.extend({
  DATABASE_URL: postgresUrl,
  DIRECT_URL: postgresUrl,
  SUPABASE_SECRET_KEY: z.string().min(20),
  PAYMENT_PROVIDER: z.enum(["mock"]).default("mock"),
  /** Signs/verifies mock gateway webhooks. Random, at least 32 characters. */
  MOCK_PAYMENT_WEBHOOK_SECRET: z.string().min(32),
  /** Signs/verifies mock courier status webhooks. Random, at least 32 characters. */
  MOCK_COURIER_WEBHOOK_SECRET: z.string().min(32),
});

/**
 * AI providers (worker only — the app never calls a provider). The fakes need no keys; switching a
 * provider on requires its keys (checked by workerEnvSchema). See docs/developers/ai-pipelines.md.
 */
const aiEnvShape = {
  PLANNER_PROVIDER: z.enum(["fake", "gemini"]).default("fake"),
  IMAGE_PROVIDER: z.enum(["fake", "cloudflare"]).default("fake"),
  GEMINI_API_KEY: z.string().min(20).optional(),
  /** The strongest Flash model that answers reliably on the free tier (measured 2026-11-11); the lighter ones follow. */
  GEMINI_MODEL: z.string().regex(/^[a-z0-9.-]{3,60}$/).default("gemini-3.6-flash"),
  /** Comma-separated models tried in order when GEMINI_MODEL is busy, retired or answers badly. Empty = none. */
  GEMINI_FALLBACK_MODELS: z
    .string()
    .regex(/^([a-z0-9.-]{3,60}(,[a-z0-9.-]{3,60}){0,4})?$/)
    .default("gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite")
    .transform((v) => v.split(",").filter(Boolean)),
  CLOUDFLARE_ACCOUNT_ID: z.string().regex(/^[a-f0-9]{32}$/).optional(),
  CLOUDFLARE_API_TOKEN: z.string().min(20).optional(),
  CLOUDFLARE_IMAGE_MODEL: z.string().regex(/^@cf\/[a-z0-9./-]{3,100}$/).default("@cf/black-forest-labs/flux-2-klein-4b"),
  /** Comma-separated models tried in order when CLOUDFLARE_IMAGE_MODEL fails (not when the daily allowance is used up). Empty = none. */
  CLOUDFLARE_FALLBACK_IMAGE_MODELS: z
    .string()
    .regex(/^(@cf\/[a-z0-9./-]{3,100}(,@cf\/[a-z0-9./-]{3,100}){0,3})?$/)
    .default("@cf/black-forest-labs/flux-1-schnell")
    .transform((v) => v.split(",").filter(Boolean)),
  /**
   * A customer's own garment photo turned into a clean product shot by an image model before it's cut out
   * (lib/own-dress). "none" (default) skips it. "cloudflare" (FLUX.2 klein, within the free daily allowance)
   * sends the photo to Cloudflare; "gemini" needs a paid key. A refusal or quota error falls back to the photo.
   */
  GARMENT_SHOT_PROVIDER: z.enum(["none", "gemini", "cloudflare"]).default("none"),
  CLOUDFLARE_SHOT_MODEL: z.string().regex(/^@cf\/[a-z0-9./-]{3,100}$/).default("@cf/black-forest-labs/flux-2-klein-4b"),
  GEMINI_IMAGE_MODEL: z.string().regex(/^[a-z0-9.-]{3,60}$/).default("gemini-2.5-flash-image"),
  /** Artificial latency of the fake providers, so loading states are visible in development. */
  AI_FAKE_DELAY_MS: z.coerce.number().int().min(0).max(30_000).default(1_500),
  /** Hard limit for one attempt at an AI job. */
  AI_JOB_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(180_000),
  /** Virtual try-on: deterministic fake (default), free public Hugging Face Spaces, or a model on this machine. */
  TRYON_PROVIDER: z.enum(["fake", "huggingface", "local"]).default("fake"),
  /** TRYON_PROVIDER=local: where `pnpm tryon:setup` put the model and its Python (default ~/.cache/clothseeker/local-tryon). */
  LOCAL_TRYON_DIR: z.string().startsWith("/").max(500).optional(),
  /** TRYON_PROVIDER=local: denoising steps (fewer is faster and rougher). */
  LOCAL_TRYON_STEPS: z.coerce.number().int().min(10).max(50).default(30),
  /** TRYON_PROVIDER=local: the model's picture width in pixels (height is 4/3 of it). 384 suits an 8 GB Mac. */
  LOCAL_TRYON_WIDTH: z.coerce
    .number()
    .int()
    .min(192)
    .max(768)
    .refine((w) => w % 24 === 0, "a multiple of 24")
    .default(384),
  /** Optional free Hugging Face account token; raises the shared ZeroGPU allowance. */
  HF_TOKEN: z.string().regex(/^hf_[A-Za-z0-9]{20,}$/).optional(),
  /** Comma-separated Spaces tried in order (see lib/ai/providers/tryon-hf.ts). */
  TRYON_SPACES: z
    .string()
    .regex(/^(jallenjia\/Change-Clothes-AI|yisol\/IDM-VTON|levihsu\/OOTDiffusion|franciszzj\/Leffa)(,(jallenjia\/Change-Clothes-AI|yisol\/IDM-VTON|levihsu\/OOTDiffusion|franciszzj\/Leffa))*$/)
    .default("jallenjia/Change-Clothes-AI,yisol/IDM-VTON,levihsu/OOTDiffusion,franciszzj/Leffa")
    .transform((v) => v.split(",")),
  /** Limit for one try-on attempt (free Spaces queue and cold-start). */
  TRYON_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(900_000).default(240_000),
};

/** Customer emails (worker only). `log` sends nothing; `smtp` needs SMTP_URL (Mailpit locally). */
const emailEnvShape = {
  EMAIL_PROVIDER: z.enum(["log", "smtp"]).default("log"),
  SMTP_URL: z.url({ protocol: /^smtps?$/ }).optional(),
  EMAIL_FROM: z.string().min(3).max(120).default("ClothSeeker <orders@clothseeker.test>"),
  /** Links in emails point here. */
  NEXT_PUBLIC_APP_URL: httpUrl.default("http://localhost:3000"),
};

export const workerEnvSchema = z.object({
  DATABASE_URL: postgresUrl,
  NEXT_PUBLIC_SUPABASE_URL: httpUrl,
  SUPABASE_SECRET_KEY: z.string().min(20),
  /** The worker refunds overdue custom items through the payment provider. */
  MOCK_PAYMENT_WEBHOOK_SECRET: z.string().min(32),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),
  /** If set, the worker answers GET /health on this port (used by local E2E runs). */
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1024).max(65_535).optional(),
  ...aiEnvShape,
  ...emailEnvShape,
}).superRefine((env, ctx) => {
  for (const key of missingAiKeys(env)) {
    ctx.addIssue({ code: "custom", path: [key], message: "Required by the chosen AI provider" });
  }
  if (env.EMAIL_PROVIDER === "smtp" && !env.SMTP_URL) {
    ctx.addIssue({ code: "custom", path: ["SMTP_URL"], message: "Required when EMAIL_PROVIDER=smtp" });
  }
});

/** Keys the chosen providers need but don't have. */
export function missingAiKeys(
  env: { PLANNER_PROVIDER: string; IMAGE_PROVIDER: string; GARMENT_SHOT_PROVIDER?: string } & Partial<Record<"GEMINI_API_KEY" | "CLOUDFLARE_ACCOUNT_ID" | "CLOUDFLARE_API_TOKEN", string>>,
): string[] {
  const missing: string[] = [];
  if ((env.PLANNER_PROVIDER === "gemini" || env.GARMENT_SHOT_PROVIDER === "gemini") && !env.GEMINI_API_KEY) {
    missing.push("GEMINI_API_KEY");
  }
  if (env.IMAGE_PROVIDER === "cloudflare" || env.GARMENT_SHOT_PROVIDER === "cloudflare") {
    if (!env.CLOUDFLARE_ACCOUNT_ID) {
      missing.push("CLOUDFLARE_ACCOUNT_ID");
    }
    if (!env.CLOUDFLARE_API_TOKEN) {
      missing.push("CLOUDFLARE_API_TOKEN");
    }
  }
  return missing;
}

export type ClientEnv = z.infer<typeof clientEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export class EnvValidationError extends Error {
  override readonly name = "EnvValidationError";

  constructor(
    readonly scope: string,
    readonly invalidKeys: readonly string[],
  ) {
    // Only variable names are reported, never values, so secrets cannot leak into logs.
    super(
      `Invalid or missing ${scope} environment variables: ${invalidKeys.join(", ")}. ` +
        "See .env.example and docs/developers/local-setup.md.",
    );
  }
}

export function parseEnv<TSchema extends z.ZodType>(
  schema: TSchema,
  source: Record<string, string | undefined>,
  scope: string,
): z.infer<TSchema> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const keys = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw new EnvValidationError(scope, keys);
  }
  return result.data;
}
