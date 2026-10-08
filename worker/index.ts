import { loadEnvConfig } from "@next/env";

import { createClient } from "@supabase/supabase-js";

import { createPrismaClient } from "@/lib/db/client";
import { EnvValidationError, parseEnv, workerEnvSchema } from "@/lib/env/schema";
import { expireStalePendingOrders } from "@/lib/orders/expiry";
import { SupabaseStorageAdapter } from "@/lib/storage/supabase-core";

import { errorName, log } from "./logger";

// Local background worker (runs on the developer's Mac mini).
// Each poll: expire unpaid orders (Phase 4). Job claiming from the `ai_jobs` queue arrives in Phase 6.
//
//   pnpm worker          run until Ctrl+C
//   pnpm worker:check    connect, verify the database, exit

async function main(): Promise<number> {
  loadEnvConfig(process.cwd());
  const once = process.argv.includes("--once");

  let env;
  try {
    env = parseEnv(workerEnvSchema, process.env, "worker");
  } catch (error) {
    log.error("worker.env_invalid", {
      keys: error instanceof EnvValidationError ? error.invalidKeys.join(",") : undefined,
    });
    return 1;
  }

  const prisma = createPrismaClient(env.DATABASE_URL);
  const shutdown = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      log.info("worker.stopping", { signal });
      shutdown.abort();
    });
  }

  try {
    await prisma.$queryRaw`SELECT 1`;
    log.info("worker.db_connected", { mode: once ? "check" : "loop" });

    if (once) {
      return 0;
    }

    const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const storage = new SupabaseStorageAdapter(() => supabase);

    log.info("worker.started", { pollIntervalMs: env.WORKER_POLL_INTERVAL_MS });
    while (!shutdown.signal.aborted) {
      try {
        const expired = await expireStalePendingOrders(prisma, storage, new Date());
        if (expired > 0) {
          log.info("orders.expired", { count: expired });
        }
      } catch (error) {
        // One failed sweep must not stop the worker; it retries on the next poll.
        log.error("orders.expiry_failed", { error: errorName(error) });
      }
      // Phase 6: claim and process queued AI jobs here.
      await sleep(env.WORKER_POLL_INTERVAL_MS, shutdown.signal);
    }
    return 0;
  } catch (error) {
    log.error("worker.failed", { error: errorName(error) });
    return 1;
  } finally {
    await prisma.$disconnect();
    log.info("worker.stopped");
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    log.error("worker.crashed", { error: errorName(error) });
    process.exit(1);
  },
);
