import { defineConfig, devices } from "@playwright/test";

const PORT = 3000;
const WORKER_HEALTH_PORT = 3101;
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // CI runs against the production build made in the previous step. Locally we build first:
      // the dev server compiles routes on first visit, which made parallel runs flaky.
      // Set E2E_DEV=1 to test against `pnpm dev` instead.
      command: isCI
        ? `pnpm start --port ${PORT}`
        : process.env.E2E_DEV
          ? `pnpm dev --port ${PORT}`
          : `pnpm build && pnpm start --port ${PORT}`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !isCI,
      timeout: 240_000,
    },
    // Locally, the @supabase AI tests need the worker. It always uses the fake AI providers here,
    // whatever .env.local says. CI has no Supabase stack, so no worker either.
    ...(isCI
      ? []
      : [
          {
            command: "pnpm worker",
            url: `http://127.0.0.1:${WORKER_HEALTH_PORT}/health`,
            reuseExistingServer: true,
            timeout: 60_000,
            env: {
              WORKER_HEALTH_PORT: String(WORKER_HEALTH_PORT),
              WORKER_POLL_INTERVAL_MS: "500",
              PLANNER_PROVIDER: "fake",
              IMAGE_PROVIDER: "fake",
              AI_FAKE_DELAY_MS: "800",
            },
          },
        ]),
  ],
});
