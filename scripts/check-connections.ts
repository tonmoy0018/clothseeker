import { loadEnvConfig } from "@next/env";
import { createClient } from "@supabase/supabase-js";

import { createPrismaClient } from "@/lib/db/client";
import { BUCKETS } from "@/lib/storage/buckets";
import { EnvValidationError, parseEnv, serverEnvSchema } from "@/lib/env/schema";

// `pnpm db:check` — verifies env vars, Postgres via Prisma, and Supabase Storage buckets.
// Prints only pass/fail per check; never prints values.

async function main(): Promise<number> {
  loadEnvConfig(process.cwd());

  let env;
  try {
    env = parseEnv(serverEnvSchema, process.env, "server");
    report("env", true);
  } catch (error) {
    report("env", false, error instanceof EnvValidationError ? error.message : "unknown error");
    return 1;
  }

  let ok = true;

  const prisma = createPrismaClient(env.DATABASE_URL);
  try {
    await prisma.$queryRaw`SELECT 1`;
    report("postgres (DATABASE_URL)", true);

    // Every public table must have RLS on, or Supabase's REST API exposes it to the publishable key.
    const unprotected = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity ORDER BY tablename`;
    const rlsOk = unprotected.length === 0;
    ok &&= rlsOk;
    report("row level security on all public tables", rlsOk, `missing on: ${unprotected.map((t) => t.tablename).join(", ")}`);
  } catch (error) {
    ok = false;
    report("postgres (DATABASE_URL)", false, error instanceof Error ? error.name : "unknown error");
  } finally {
    await prisma.$disconnect();
  }

  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) {
    ok = false;
    report("supabase storage", false, error.name);
  } else {
    for (const name of Object.values(BUCKETS)) {
      const bucket = buckets.find((b) => b.name === name);
      const healthy = bucket !== undefined && !bucket.public;
      ok &&= healthy;
      report(`bucket ${name} (private)`, healthy, bucket ? "bucket is public" : "missing");
    }
  }

  return ok ? 0 : 1;
}

function report(check: string, passed: boolean, detail?: string): void {
  console.log(`${passed ? "PASS" : "FAIL"}  ${check}${!passed && detail ? ` — ${detail}` : ""}`);
}

main().then(
  (code) => process.exit(code),
  () => process.exit(1),
);
