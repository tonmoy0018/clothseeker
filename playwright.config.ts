import { defineConfig, devices } from "@playwright/test";

const PORT = 3000;
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
  webServer: {
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
});
