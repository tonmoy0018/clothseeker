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
  GEMINI_MODEL: z.string().regex(/^[a-z0-9.-]{3,60}$/).default("gemini-3.8-flash"),
  /** Comma-separated models tried in order when GEMINI_MODEL is busy or retired. Empty = none. */
  GEMINI_FALLBACK_MODELS: z
    .string()
    .regex(/^([a-z0-9.-]{3,60}(,[a-z0-9.-]{3,60}){0,4})?$/)
    .default("gemini-3.6-flash,gemini-3.5-flash")
    .transform((v) => v.split(",").filter(Boolean)),
  CLOUDFLARE_ACCOUNT_ID: z.string().regex(/^[a-f0-9]{32}$/).optional(),
  CLOUDFLARE_API_TOKEN: z.string().min(20).optional(),
  CLOUDFLARE_IMAGE_MODEL: z.string().regex(/^@cf\/[a-z0-9./-]{3,100}$/).default("@cf/black-forest-labs/flux-1-schnell"),
  /** Artificial latency of the fake providers, so loading states are visible in development. */
  AI_FAKE_DELAY_MS: z.coerce.number().int().min(0).max(30_000).default(1_500),
  /** Hard limit for one attempt at an AI job. */
  AI_JOB_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
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
}).superRefine((env, ctx) => {
  for (const key of missingAiKeys(env)) {
    ctx.addIssue({ code: "custom", path: [key], message: "Required by the chosen AI provider" });
  }
});

/** Keys the chosen providers need but don't have. */
export function missingAiKeys(env: { PLANNER_PROVIDER: string; IMAGE_PROVIDER: string } & Partial<Record<"GEMINI_API_KEY" | "CLOUDFLARE_ACCOUNT_ID" | "CLOUDFLARE_API_TOKEN", string>>): string[] {
  const missing: string[] = [];
  if (env.PLANNER_PROVIDER === "gemini" && !env.GEMINI_API_KEY) {
    missing.push("GEMINI_API_KEY");
  }
  if (env.IMAGE_PROVIDER === "cloudflare") {
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
