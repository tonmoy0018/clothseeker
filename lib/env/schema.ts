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

export const workerEnvSchema = z.object({
  DATABASE_URL: postgresUrl,
  NEXT_PUBLIC_SUPABASE_URL: httpUrl,
  SUPABASE_SECRET_KEY: z.string().min(20),
  /** The worker refunds overdue custom items through the payment provider. */
  MOCK_PAYMENT_WEBHOOK_SECRET: z.string().min(32),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),
});

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
