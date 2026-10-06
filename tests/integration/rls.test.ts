import { describe, expect, it } from "vitest";

import { db, resetDatabaseBeforeEach } from "./helpers";

resetDatabaseBeforeEach();

describe("row level security", () => {
  it("is enabled on every public table, so Supabase's REST API exposes nothing", async () => {
    const unprotected = await db.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity`;
    expect(unprotected.map((t) => t.tablename)).toEqual([]);
  });
});
