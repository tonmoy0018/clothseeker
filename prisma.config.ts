import { loadEnvConfig } from "@next/env";
import { defineConfig } from "prisma/config";

// Load .env / .env.local the same way Next.js does, so CLI, app and worker agree.
loadEnvConfig(process.cwd());

// Migrations use the direct (non-pooled) connection. `prisma generate` needs no URL,
// so it still works in CI and on a fresh clone before .env.local exists.
const directUrl = process.env.DIRECT_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  ...(directUrl ? { datasource: { url: directUrl } } : {}),
});
