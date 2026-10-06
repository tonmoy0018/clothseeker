import "server-only";

import { getServerEnv } from "@/lib/env/server";

import { createPrismaClient, type PrismaClient } from "./client";

// Reuse one client across hot reloads in development to avoid exhausting connections.
const globalForPrisma = globalThis as typeof globalThis & { __prisma?: PrismaClient };

export function getPrisma(): PrismaClient {
  globalForPrisma.__prisma ??= createPrismaClient(getServerEnv().DATABASE_URL);
  return globalForPrisma.__prisma;
}
