import { execFileSync } from "node:child_process";

import { Client } from "pg";

import { getTestDatabaseUrl } from "./test-env";

// Creates the test database if needed and applies all committed migrations to it.
export default async function setup(): Promise<void> {
  const testUrl = getTestDatabaseUrl();
  const target = new URL(testUrl);
  const dbName = target.pathname.slice(1);

  const admin = new URL(testUrl);
  admin.pathname = "/postgres";
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (exists.rowCount === 0) {
      // dbName is validated by getTestDatabaseUrl (^[a-z0-9_]+_test$), so quoting it is safe.
      await client.query(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await client.end();
  }

  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    env: { ...process.env, DIRECT_URL: testUrl, DATABASE_URL: testUrl },
    stdio: "pipe",
  });
}
