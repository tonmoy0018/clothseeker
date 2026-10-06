import { clientEnvSchema, parseEnv, type ClientEnv } from "./schema";

let cached: ClientEnv | undefined;

/**
 * Browser-safe env. Each variable is referenced statically so Next.js can inline it
 * into the client bundle; do not refactor this into a dynamic `process.env[key]` lookup.
 */
export function getClientEnv(): ClientEnv {
  cached ??= parseEnv(
    clientEnvSchema,
    {
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    },
    "client",
  );
  return cached;
}
