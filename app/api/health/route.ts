import { connection } from "next/server";

import { getPrisma } from "@/lib/db";

// Liveness + database check. Returns no versions, hosts or error details.
export async function GET() {
  await connection();
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return Response.json({ ok: true, db: "up" });
  } catch (error) {
    console.error(JSON.stringify({ level: "error", msg: "health.db_unreachable", error: errorName(error) }));
    return Response.json({ ok: false, db: "down" }, { status: 503 });
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
