import { execFileSync } from "node:child_process";

// After a local E2E run, remove the accounts and dresses the tests created (scripts/clean-test-data.ts),
// so they don't pile up in the development shop. CI has no Supabase stack, so nothing to clean there.
export default function globalTeardown(): void {
  if (process.env.CI || process.env.E2E_KEEP_DATA) {
    return;
  }
  execFileSync("pnpm", ["--silent", "db:clean-test"], { stdio: "inherit" });
}
