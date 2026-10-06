import { existsSync } from "node:fs";

import { z } from "zod";

/** Integration tests only ever touch a database whose name ends in "_test". */
export function getTestDatabaseUrl(): string {
  // @next/env deliberately ignores .env.local when NODE_ENV=test, so load it explicitly.
  // Existing environment variables (e.g. in CI) are never overridden.
  if (existsSync(".env.local")) {
    process.loadEnvFile(".env.local");
  }
  const url = z.url({ protocol: /^postgres(ql)?$/ }).safeParse(process.env.TEST_DATABASE_URL);
  if (!url.success) {
    throw new Error("TEST_DATABASE_URL is missing or invalid. Run `pnpm env:local --force` or see docs/developers/testing.md.");
  }
  const name = new URL(url.data).pathname.replace(/^\//, "");
  if (!/^[a-z0-9_]+_test$/.test(name)) {
    throw new Error(`Refusing to run integration tests against database "${name}": its name must end in _test.`);
  }
  return url.data;
}
