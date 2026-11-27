import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

// `pnpm hosted <command…>` — runs a command against the live (hosted) ClothSeeker: the values in
// .env.hosted.nosync are set before the command starts, so they win over .env.local (the app, worker,
// Prisma and the seed all load their env files without overriding what is already set). Anything the
// file leaves out (e.g. the AI providers) still comes from .env.local.
//
//   pnpm hosted prisma migrate deploy
//   pnpm hosted tsx prisma/seed.ts --allow-remote
//   pnpm worker:hosted
//
// The file holds production secrets: git ignores `.env*`, and iCloud never syncs `*.nosync`. It is not
// named .env.production.local because Next.js and the worker would load that one on their own.
// See docs/developers/deployment.md. Never prints values.

const FILE = ".env.hosted.nosync";

function main(): number {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error("Usage: pnpm hosted <command> [args…]");
    return 1;
  }
  if (!existsSync(FILE)) {
    console.error(`${FILE} is missing. Create it as described in docs/developers/deployment.md.`);
    return 1;
  }
  const hosted = parseEnv(readFileSync(FILE, "utf8"));
  const database = hosted.DATABASE_URL;
  if (!database || ["127.0.0.1", "localhost", "::1"].includes(new URL(database).hostname)) {
    console.error(`${FILE} must set DATABASE_URL to the hosted database.`);
    return 1;
  }
  const result = spawnSync(command, args, { stdio: "inherit", env: { ...process.env, ...hosted }, shell: false });
  if (result.error) {
    console.error(`Couldn't run ${command}: ${result.error.name}`);
    return 1;
  }
  return result.status ?? 1;
}

process.exitCode = main();
