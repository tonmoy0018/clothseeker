import { loadEnvConfig } from "@next/env";

import { createPrismaClient } from "@/lib/db/client";
import { EnvValidationError, parseEnv, workerEnvSchema } from "@/lib/env/schema";

import { errorName, log } from "./logger";

// Local background worker (runs on the developer's Mac mini).
// Phase 0: connects and idles. Job claiming from the `ai_jobs` queue arrives in Phase 6.
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

    log.info("worker.started", { pollIntervalMs: env.WORKER_POLL_INTERVAL_MS });
    while (!shutdown.signal.aborted) {
      // Phase 6: claim and process queued jobs here.
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
