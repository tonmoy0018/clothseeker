import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { hostname } from "node:os";

import { loadEnvConfig } from "@next/env";

import { createClient } from "@supabase/supabase-js";

import { getAiProviders } from "@/lib/ai";
import { recordHeartbeat } from "@/lib/ai/worker/heartbeat";
import { runAiJobs, type AiWorkerDeps } from "@/lib/ai/worker/run";
import { createPrismaClient } from "@/lib/db/client";
import { EnvValidationError, parseEnv, workerEnvSchema } from "@/lib/env/schema";
import { expireStalePendingOrders } from "@/lib/orders/expiry";
import { MockPaymentProvider } from "@/lib/payments/mock";
import { expireOverdueAcceptances } from "@/lib/production/acceptance";
import { retryPendingRefunds } from "@/lib/production/refunds";
import { SupabaseStorageAdapter } from "@/lib/storage/supabase-core";
import { expireQuotes } from "@/lib/quotes/service";
import { cleanupTryOnMedia } from "@/lib/tryon/service";

import { errorName, log } from "./logger";

// Local background worker (runs on the developer's Mac mini).
// Each poll: expire unpaid orders, refund custom items not accepted within 24 h, retry failed refunds,
// delete unsaved try-on photos/results after 24 h, expire unanswered or unpaid quotes, then claim and
// run queued AI jobs (lib/ai/worker).
// Several workers can run at once safely.
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
  let health: Server | null = null;
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
    const payments = new MockPaymentProvider(env.MOCK_PAYMENT_WEBHOOK_SECRET);
    const providers = getAiProviders(env);
    const ai: AiWorkerDeps = {
      db: prisma,
      storage,
      providers,
      workerId: `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
      timeoutMs: env.AI_JOB_TIMEOUT_MS,
      timeoutsMs: { TRY_ON: env.TRYON_TIMEOUT_MS },
      log: (msg, fields) => log.info(msg, fields),
    };
    health = env.WORKER_HEALTH_PORT ? await startHealthServer(env.WORKER_HEALTH_PORT) : null;
    const heartbeat = { workerId: ai.workerId, planner: providers.planner.name, image: providers.image.name, tryOn: providers.tryOn.name, startedAt: new Date() };

    log.info("worker.started", {
      pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
      planner: providers.planner.name,
      images: providers.image.name,
      tryOn: providers.tryOn.name,
      healthPort: env.WORKER_HEALTH_PORT,
    });
    while (!shutdown.signal.aborted) {
      // Each sweep is idempotent; one failing must not stop the others or the worker.
      const now = new Date();
      const sweeps: [string, () => Promise<number>][] = [
        ["worker.heartbeat", () => recordHeartbeat(prisma, heartbeat, now).then(() => 0)],
        ["orders.expired", () => expireStalePendingOrders(prisma, storage, now)],
        ["acceptance.timed_out", () => expireOverdueAcceptances(prisma, payments, now)],
        ["refunds.settled", () => retryPendingRefunds(prisma, payments)],
        ["tryon.cleaned", () => cleanupTryOnMedia(prisma, storage, now)],
        ["quotes.expired", () => expireQuotes(prisma, now)],
      ];
      for (const [name, sweep] of sweeps) {
        try {
          const count = await sweep();
          if (count > 0) {
            log.info(name, { count });
          }
        } catch (error) {
          log.error(`${name}_failed`, { error: errorName(error) });
        }
      }
      let aiJobs = 0;
      try {
        aiJobs = await runAiJobs(ai);
      } catch (error) {
        log.error("ai.poll_failed", { error: errorName(error) });
      }
      // Busy queue: poll again straight away instead of sleeping.
      if (aiJobs === 0) {
        await sleep(env.WORKER_POLL_INTERVAL_MS, shutdown.signal);
      }
    }
    return 0;
  } catch (error) {
    log.error("worker.failed", { error: errorName(error) });
    return 1;
  } finally {
    health?.close();
    await prisma.$disconnect();
    log.info("worker.stopped");
  }
}

/** Local-only readiness probe (used by Playwright to wait for the worker). */
function startHealthServer(port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const ok = req.method === "GET" && req.url === "/health";
    res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
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
