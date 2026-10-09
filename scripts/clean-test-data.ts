import { loadEnvConfig } from "@next/env";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { createPrismaClient, type PrismaClient } from "@/lib/db/client";
import { parseEnv } from "@/lib/env/schema";
import { BUCKETS, type BucketName } from "@/lib/storage/buckets";

// Removes data that automated tests leave in the LOCAL development database and storage:
// accounts signed up by E2E tests (e2e-…@example.test, and real-/shots- from manual checks) with
// everything they own, and dresses created by the admin E2E test (slug e2e-test-dress-…).
//
//   pnpm db:clean-test                       test accounts and test dresses
//   pnpm db:clean-test --dry-run             only report what would be removed
//   pnpm db:clean-test --demo-before=<ISO>   also clear the demo customers' (ava/noah/mia) orders,
//                                            designs, carts, AI, try-ons and quotes made before then
//
// Playwright runs it after every local E2E run (tests/e2e/global-teardown.ts). It refuses to run
// against a non-local database. Run `pnpm db:seed` afterwards to restore the demo dresses' stock.

const TEST_EMAIL_PREFIXES = ["e2e-", "real-", "shots-"];
const TEST_EMAIL_DOMAIN = "@example.test";
const TEST_PRODUCT_SLUG_PREFIX = "e2e-test-dress-";
const DEMO_CUSTOMERS = ["ava@example.test", "noah@example.test", "mia@example.test"];

type Options = { dryRun: boolean; demoBefore: Date | null };

function parseOptions(argv: string[]): Options {
  const demo = argv.find((a) => a.startsWith("--demo-before="))?.split("=")[1];
  const demoBefore = demo ? new Date(demo) : null;
  if (demoBefore && Number.isNaN(demoBefore.getTime())) {
    throw new Error("--demo-before must be an ISO date, e.g. 2026-10-09T09:25:00Z");
  }
  return { dryRun: argv.includes("--dry-run"), demoBefore };
}

function assertLocalDatabase(databaseUrl: string): void {
  const host = new URL(databaseUrl).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("Refusing to clean a non-local database.");
  }
}

/** Every object key under `prefix` (Supabase lists one folder level at a time). */
async function listKeys(supabase: SupabaseClient, bucket: BucketName, prefix: string, before: Date | null): Promise<string[]> {
  const keys: string[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: 1000, offset });
    if (error) throw new Error(`Listing ${bucket}/${prefix} failed: ${error.message}`);
    for (const entry of data) {
      const path = `${prefix}/${entry.name}`;
      if (entry.id === null) {
        keys.push(...(await listKeys(supabase, bucket, path, before)));
      } else if (!before || !entry.created_at || new Date(entry.created_at) < before) {
        keys.push(path);
      }
    }
    if (data.length < 1000) return keys;
  }
}

async function removeKeys(supabase: SupabaseClient, bucket: BucketName, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 100) {
    const { error } = await supabase.storage.from(bucket).remove(keys.slice(i, i + 100));
    if (error) throw new Error(`Removing files from ${bucket} failed: ${error.message}`);
  }
}

async function cleanTestAccounts(db: PrismaClient, supabase: SupabaseClient, dryRun: boolean) {
  const users = await db.user.findMany({
    where: { OR: TEST_EMAIL_PREFIXES.map((p) => ({ email: { startsWith: p, endsWith: TEST_EMAIL_DOMAIN } })) },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  const orders = await db.order.findMany({ where: { customerId: { in: ids } }, select: { id: true } });
  if (dryRun || ids.length === 0) {
    return { accounts: ids.length, orders: orders.length };
  }
  const files: [BucketName, string[]][] = [];
  for (const id of ids) {
    files.push([BUCKETS.designAssets, await listKeys(supabase, BUCKETS.designAssets, id, null)]);
    files.push([BUCKETS.tryonPrivate, await listKeys(supabase, BUCKETS.tryonPrivate, id, null)]);
  }
  for (const order of orders) {
    files.push([BUCKETS.qcPhotos, await listKeys(supabase, BUCKETS.qcPhotos, order.id, null)]);
  }
  // Orders don't cascade from customers (they're kept for accounting), so they go first; a dispute
  // blocks deleting its order item, so disputes go before them.
  await db.dispute.deleteMany({ where: { orderItem: { orderId: { in: orders.map((o) => o.id) } } } });
  await db.order.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } });
  await db.flaggedItem.deleteMany({ where: { customerId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  for (const [bucket, keys] of files) {
    await removeKeys(supabase, bucket, keys);
  }
  for (const id of ids) {
    const { error } = await supabase.auth.admin.deleteUser(id);
    if (error && !/not found/i.test(error.message)) throw new Error(`Deleting a test sign-in failed: ${error.message}`);
  }
  return { accounts: ids.length, orders: orders.length };
}

async function cleanTestProducts(db: PrismaClient, supabase: SupabaseClient, dryRun: boolean) {
  const products = await db.product.findMany({ where: { slug: { startsWith: TEST_PRODUCT_SLUG_PREFIX } }, select: { id: true } });
  const ids = products.map((p) => p.id);
  if (dryRun || ids.length === 0) {
    return { dresses: ids.length };
  }
  // Designs block product deletion; quotes block design deletion.
  await db.quoteRequest.deleteMany({ where: { design: { productId: { in: ids } } } });
  await db.design.deleteMany({ where: { productId: { in: ids } } });
  await db.product.deleteMany({ where: { id: { in: ids } } });
  for (const id of ids) {
    await removeKeys(supabase, BUCKETS.productMedia, await listKeys(supabase, BUCKETS.productMedia, id, null));
  }
  return { dresses: ids.length };
}

async function cleanDemoActivity(db: PrismaClient, supabase: SupabaseClient, before: Date, dryRun: boolean) {
  const users = await db.user.findMany({ where: { email: { in: DEMO_CUSTOMERS } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const old = { customerId: { in: ids }, createdAt: { lt: before } };
  const orders = await db.order.findMany({ where: old, select: { id: true } });
  const designs = await db.design.count({ where: old });
  if (dryRun) {
    return { demoOrders: orders.length, demoDesigns: designs };
  }
  const files: [BucketName, string[]][] = [];
  for (const id of ids) {
    files.push([BUCKETS.designAssets, await listKeys(supabase, BUCKETS.designAssets, id, before)]);
    files.push([BUCKETS.tryonPrivate, await listKeys(supabase, BUCKETS.tryonPrivate, id, before)]);
  }
  for (const order of orders) {
    files.push([BUCKETS.qcPhotos, await listKeys(supabase, BUCKETS.qcPhotos, order.id, null)]);
  }
  await db.$transaction(async (tx) => {
    await tx.dispute.deleteMany({ where: { orderItem: { orderId: { in: orders.map((o) => o.id) } } } });
    await tx.order.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } });
    await tx.cartItem.deleteMany({ where: { cart: { customerId: { in: ids } }, createdAt: { lt: before } } });
    await tx.quoteRequest.deleteMany({ where: old });
    await tx.tryOnResult.deleteMany({ where: old });
    await tx.tryOnPhoto.deleteMany({ where: old });
    await tx.aIRound.deleteMany({ where: old });
    await tx.aIJob.deleteMany({ where: old });
    await tx.flaggedItem.deleteMany({ where: old });
    await tx.design.deleteMany({ where: { ...old, quoteRequests: { none: {} } } });
  });
  for (const [bucket, keys] of files) {
    await removeKeys(supabase, bucket, keys);
  }
  return { demoOrders: orders.length, demoDesigns: designs };
}

async function main(): Promise<void> {
  loadEnvConfig(process.cwd());
  const env = parseEnv(
    z.object({ DATABASE_URL: z.string().min(1), NEXT_PUBLIC_SUPABASE_URL: z.url(), SUPABASE_SECRET_KEY: z.string().min(20) }),
    process.env,
    "clean-test-data",
  );
  assertLocalDatabase(env.DATABASE_URL);
  const options = parseOptions(process.argv.slice(2));
  const db = createPrismaClient(env.DATABASE_URL);
  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const summary = {
      ...(options.demoBefore ? await cleanDemoActivity(db, supabase, options.demoBefore, options.dryRun) : {}),
      ...(await cleanTestAccounts(db, supabase, options.dryRun)),
      ...(await cleanTestProducts(db, supabase, options.dryRun)),
    };
    console.log(JSON.stringify({ msg: options.dryRun ? "clean-test.dry_run" : "clean-test.done", ...summary }));
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "clean-test failed");
  process.exit(1);
});
