import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";

import { getAiMetrics } from "@/lib/admin/ai-metrics";
import { listAuditLog } from "@/lib/admin/audit-log";
import { getDisputeEvidence, listDisputes, resolveDispute } from "@/lib/admin/disputes";
import { AdminError } from "@/lib/admin/errors";
import { listFlags, reviewFlag } from "@/lib/admin/flags";
import { createDesignRoundJob } from "@/lib/ai/jobs";
import { ForbiddenError, type Actor } from "@/lib/auth/policy";
import { disputeInfoForOrder, DisputeError, openDispute } from "@/lib/disputes/service";
import { transitionItems } from "@/lib/orders/transitions";
import { BUCKETS } from "@/lib/storage/buckets";
import type { MemoryStorageAdapter } from "@/lib/storage/memory";

import { storageWithTemplateAssets, TEMPLATE, validSpec } from "../fixtures/design";

import { createProduct, createUser, db, resetDatabaseBeforeEach } from "./helpers";
import { paidOrder, payments } from "./order-fixtures";

resetDatabaseBeforeEach();

let storage: MemoryStorageAdapter;
beforeEach(async () => {
  storage = await storageWithTemplateAssets();
});

const DAY = 24 * 60 * 60 * 1000;
const REASON = "The seam on the left side is open and the colour is wrong";

/** A paid ready-made order whose item has been shipped and delivered. */
async function deliveredItem(deliveredAtTime = new Date()) {
  const { customer, order, readyItem } = await paidOrder(storage, { custom: false });
  if (!readyItem) throw new Error("no item");
  const admin = { type: "ADMIN" as const, id: (await createUser("ADMIN")).id };
  await db.$transaction(async (tx) => {
    await transitionItems(tx, { itemIds: [readyItem.id], to: "READY_TO_SHIP", actor: admin });
    await transitionItems(tx, { itemIds: [readyItem.id], to: "SHIPPED", actor: admin });
    await transitionItems(tx, { itemIds: [readyItem.id], to: "DELIVERED", actor: { type: "COURIER", id: null } });
  });
  await db.orderEvent.updateMany({ where: { orderItemId: readyItem.id, toStatus: "DELIVERED" }, data: { createdAt: deliveredAtTime } });
  return { customer, order, item: readyItem };
}

async function photo() {
  return sharp({ create: { width: 400, height: 500, channels: 3, background: "#884422" } }).jpeg().toBuffer();
}

async function expectDisputeError(promise: Promise<unknown>, code: DisputeError["code"]) {
  await expect(promise).rejects.toSatisfy((e) => e instanceof DisputeError && e.code === code);
}

describe("reporting a problem", () => {
  it("customers can report a delivered item of their own within 14 days, once, with photos", async () => {
    const { customer, order, item } = await deliveredItem();
    const other = await createUser();
    const now = new Date();

    await expectDisputeError(openDispute(db, storage, other, { itemId: item.id, reason: REASON, photos: [] }), "NOT_FOUND");
    await expectDisputeError(openDispute(db, storage, customer, { itemId: item.id, reason: "bad", photos: [] }), "INVALID");
    await expectDisputeError(openDispute(db, storage, customer, { itemId: item.id, reason: REASON, photos: [Buffer.from("<svg/>")] }), "UPLOAD_INVALID");
    await expectDisputeError(openDispute(db, storage, customer, { itemId: item.id, reason: REASON, photos: [] }, new Date(now.getTime() + 15 * DAY)), "NOT_ELIGIBLE");

    expect((await disputeInfoForOrder(db, customer, order.id, now)).reportable.map((r) => r.itemId)).toEqual([item.id]);
    const { disputeId } = await openDispute(db, storage, customer, { itemId: item.id, reason: REASON, photos: [await photo(), await photo()] }, now);
    const dispute = await db.dispute.findUniqueOrThrow({ where: { id: disputeId } });
    expect(dispute).toMatchObject({ status: "OPEN", customerId: customer.id, reason: REASON });
    expect(dispute.photoKeys).toHaveLength(2);
    expect(dispute.photoKeys.every((k) => k.startsWith(`${customer.id}/disputes/`) && storage.has(BUCKETS.designAssets, k))).toBe(true);
    expect((await db.orderItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("DISPUTED");
    expect(await db.auditLog.count({ where: { action: "dispute.opened", targetId: disputeId, actorId: customer.id } })).toBe(1);

    await expectDisputeError(openDispute(db, storage, customer, { itemId: item.id, reason: REASON, photos: [] }), "NOT_ELIGIBLE");
    expect((await disputeInfoForOrder(db, customer, order.id)).reportable).toEqual([]);
  });

  it("items that aren't delivered can't be disputed", async () => {
    const { customer, readyItem } = await paidOrder(storage, { custom: false });
    await expectDisputeError(openDispute(db, storage, customer, { itemId: readyItem?.id, reason: REASON, photos: [] }), "NOT_ELIGIBLE");
  });
});

describe("resolving disputes", () => {
  it("a refund returns the item's price once and is audited; the evidence has no address or phone", async () => {
    const { customer, order, item } = await deliveredItem();
    const admin = await createUser("ADMIN");
    const { disputeId } = await openDispute(db, storage, customer, { itemId: item.id, reason: REASON, photos: [await photo()] });

    await expect(listDisputes(db, customer, "open")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(resolveDispute(db, payments, customer, { disputeId, outcome: "refund", note: "Sorry about that" })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listDisputes(db, admin, "open")).map((d) => d.id)).toEqual([disputeId]);

    const evidence = await getDisputeEvidence(db, storage, admin, disputeId);
    expect(evidence?.customerPhotoUrls).toHaveLength(1);
    expect(evidence?.timeline.map((e) => e.status)).toContain("DISPUTED");
    const serialized = JSON.stringify(evidence);
    for (const secret of [order.shippingPhone, order.shippingLine1, order.shippingName]) {
      expect(serialized).not.toContain(secret);
    }

    await resolveDispute(db, payments, admin, { disputeId, outcome: "refund", note: "Sorry, refunded in full" });
    expect((await db.orderItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("REFUNDED");
    expect(await db.dispute.findUniqueOrThrow({ where: { id: disputeId } })).toMatchObject({ status: "RESOLVED_REFUND", resolution: "Sorry, refunded in full" });
    const refunds = await db.refund.findMany({ where: { orderItemId: item.id } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ status: "SUCCEEDED", amountMinor: item.unitPriceMinor * item.quantity });
    expect(await db.auditLog.count({ where: { action: "dispute.refunded", actorId: admin.id } })).toBe(1);

    await expect(resolveDispute(db, payments, admin, { disputeId, outcome: "refund", note: "Again" })).rejects.toBeInstanceOf(AdminError);
    expect(await db.refund.count({ where: { orderItemId: item.id } })).toBe(1);
    expect((await disputeInfoForOrder(db, customer, order.id)).disputes[0]).toMatchObject({ status: "RESOLVED_REFUND" });
  });

  it("no refund puts the item back to delivered, and it can't be disputed again", async () => {
    const { customer, item } = await deliveredItem();
    const admin = await createUser("ADMIN");
    const { disputeId } = await openDispute(db, storage, customer, { itemId: item.id, reason: REASON, photos: [] });
    await resolveDispute(db, payments, admin, { disputeId, outcome: "reject", note: "The photos show normal linen texture" });
    expect((await db.orderItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("DELIVERED");
    expect(await db.refund.count({ where: { orderItemId: item.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { action: "dispute.rejected" } })).toBe(1);
    await expectDisputeError(openDispute(db, storage, customer, { itemId: item.id, reason: REASON, photos: [] }), "NOT_ELIGIBLE");
  });
});

describe("brand-logo flags", () => {
  async function flag(customer: Actor) {
    const key = `${customer.id}/ai-inputs/${randomUUID()}.webp`;
    await storage.put(BUCKETS.designAssets, key, await sharp({ create: { width: 300, height: 300, channels: 3, background: "#e4002b" } }).webp().toBuffer(), "image/webp");
    return db.flaggedItem.create({ data: { kind: "BRAND_LOGO", customerId: customer.id, storageKey: key, reason: "Brand logo detected" } });
  }

  it("confirming deletes the photo, dismissing keeps it; each once, audited, admins only", async () => {
    const customer = await createUser();
    const admin = await createUser("ADMIN");
    const a = await flag(customer);
    const b = await flag(customer);

    await expect(listFlags(db, storage, customer, "open")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reviewFlag(db, storage, customer, { flagId: a.id, decision: "confirm" })).rejects.toBeInstanceOf(ForbiddenError);
    const open = await listFlags(db, storage, admin, "open");
    expect(open.map((f) => f.id).sort()).toEqual([a.id, b.id].sort());
    expect(open[0]?.imageUrl).toMatch(/^memory:\/\//);
    expect(open[0]?.customerRef).toHaveLength(8);

    await reviewFlag(db, storage, admin, { flagId: a.id, decision: "confirm", note: "Clear Nike swoosh" });
    expect(storage.has(BUCKETS.designAssets, a.storageKey ?? "")).toBe(false);
    expect(await db.flaggedItem.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: "CONFIRMED", storageKey: null, reviewNote: "Clear Nike swoosh" });

    await reviewFlag(db, storage, admin, { flagId: b.id, decision: "dismiss" });
    expect(storage.has(BUCKETS.designAssets, b.storageKey ?? "")).toBe(true);
    expect((await db.flaggedItem.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("DISMISSED");

    await expect(reviewFlag(db, storage, admin, { flagId: b.id, decision: "confirm" })).rejects.toBeInstanceOf(AdminError);
    expect(await db.auditLog.count({ where: { action: { in: ["flag.confirmed", "flag.dismissed"] }, actorId: admin.id } })).toBe(2);
    expect(await listFlags(db, storage, admin, "open")).toEqual([]);
  });
});

describe("AI metrics", () => {
  it("counts today's jobs, waits, failures, queue and daily-limit hits", async () => {
    const customer = await createUser();
    const admin = await createUser("ADMIN");
    const now = new Date();
    const at = (msAgo: number) => new Date(now.getTime() - msAgo);
    const job = (data: { status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED"; type?: "DESIGN_ROUND" | "TRY_ON"; createdAt: Date; startedAt?: Date; finishedAt?: Date; errorCode?: string }) =>
      db.aIJob.create({ data: { type: data.type ?? "DESIGN_ROUND", customerId: customer.id, payload: {}, inputHash: randomUUID(), ...data } });
    await job({ status: "SUCCEEDED", createdAt: at(60_000), startedAt: at(58_000), finishedAt: at(28_000) });
    await job({ status: "SUCCEEDED", createdAt: at(50_000), startedAt: at(46_000), finishedAt: at(16_000) });
    await job({ status: "FAILED", createdAt: at(40_000), startedAt: at(40_000), finishedAt: at(30_000), errorCode: "PROVIDER" });
    await job({ status: "QUEUED", createdAt: at(5_000) });
    await job({ status: "FAILED", type: "TRY_ON", createdAt: at(10 * DAY), errorCode: "TRYON_LIMIT" });

    const metrics = await getAiMetrics(db, admin, now);
    const rounds = metrics.jobs.find((j) => j.type === "DESIGN_ROUND");
    expect(rounds).toMatchObject({ today: { SUCCEEDED: 2, FAILED: 1, QUEUED: 1, RUNNING: 0 }, queued: 1, averageWaitMs: 2000, averageRunMs: 23_333 });
    expect(rounds?.failureRate).toBeCloseTo(1 / 3);
    expect(rounds?.topFailures).toEqual([{ value: "PROVIDER", count: 1 }]);
    expect(rounds?.series.at(-1)?.count).toBe(4);
    const tryOn = metrics.jobs.find((j) => j.type === "TRY_ON");
    expect(tryOn?.today.FAILED).toBe(0);
    expect(tryOn?.series.reduce((sum, d) => sum + d.count, 0)).toBe(1);
    await expect(getAiMetrics(db, customer, now)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a refused AI request is recorded as a daily-limit hit", async () => {
    const customer = await createUser();
    const admin = await createUser("ADMIN");
    const product = await createProduct({ variants: [{ size: "M", color: "Sage", priceMinor: 320_000, stock: 3 }] });
    const template = await db.customizationTemplate.create({ data: { productId: product.id, version: 1, config: TEMPLATE, isActive: true, aiEnabled: true } });
    const spec = validSpec({ productId: product.id, templateId: template.id });
    const design = await db.design.create({ data: { customerId: customer.id, productId: product.id, spec, status: "DRAFT" } });
    for (let i = 0; i < 10; i++) {
      const j = await db.aIJob.create({ data: { type: "DESIGN_ROUND", status: "SUCCEEDED", customerId: customer.id, payload: {}, inputHash: randomUUID() } });
      await db.aIRound.create({ data: { designId: design.id, customerId: customer.id, instruction: "x", inputHash: randomUUID(), jobId: j.id } });
    }
    await expect(createDesignRoundJob(db, storage, customer, { spec, instruction: "Pastel florals please" })).rejects.toThrow(/10 AI design rounds/);
    expect(await db.aiLimitHit.findFirstOrThrow()).toMatchObject({ customerId: customer.id, feature: "DESIGN_ROUND" });
    expect((await getAiMetrics(db, admin)).limitHitsToday.DESIGN_ROUND).toBe(1);
  });
});

async function dismissFlagForAudit(admin: Actor) {
  const flag = await db.flaggedItem.create({ data: { kind: "BRAND_LOGO", reason: "test" } });
  await reviewFlag(db, storage, admin, { flagId: flag.id, decision: "dismiss" });
}

describe("audit log and admin protection", () => {
  it("lists entries newest first with filters, naming admins but not customers; admins only", async () => {
    const admin = await createUser("ADMIN");
    const customer = await createUser();
    await db.user.update({ where: { id: admin.id }, data: { name: "Rina (team)" } });
    await db.auditLog.createMany({
      data: [
        { actorId: admin.id, action: "quote.priced", targetType: "quote_request", targetId: randomUUID(), metadata: { priceMinor: 500_000 }, createdAt: new Date(Date.now() - 2000) },
        { actorId: customer.id, action: "dispute.opened", targetType: "dispute", targetId: randomUUID(), metadata: { photos: 1 }, createdAt: new Date(Date.now() - 1000) },
        { actorId: null, actorRole: "SYSTEM", action: "tryon.cleanup", targetType: "try_on_media", metadata: { photos: 2 } },
        // A customer whose account was deleted later: still shown as a customer, not as the system.
        { actorId: null, actorRole: "CUSTOMER", action: "dispute.opened", targetType: "dispute", targetId: randomUUID(), metadata: { photos: 0 }, createdAt: new Date(Date.now() - 3000) },
      ],
    });
    const all = await listAuditLog(db, admin, {});
    expect(all.rows.map((r) => r.action)).toEqual(["tryon.cleanup", "dispute.opened", "quote.priced", "dispute.opened"]);
    expect(all.rows.map((r) => (r.actor.kind === "system" ? "System" : r.actor.label))).toEqual(["System", "Customer", "Rina (team)", "Customer (account deleted)"]);
    expect((await listAuditLog(db, admin, { actor: "customer" })).rows).toHaveLength(2);
    expect((await listAuditLog(db, admin, { action: "quote." })).rows).toHaveLength(1);
    expect((await listAuditLog(db, admin, { actor: "system" })).rows.map((r) => r.action)).toEqual(["tryon.cleanup"]);
    expect((await listAuditLog(db, admin, { target: "dispute" })).rows[0]?.metadata).toEqual([["photos", "1"]]);
    // New entries record who acted.
    await dismissFlagForAudit(admin);
    expect((await db.auditLog.findFirstOrThrow({ where: { action: "flag.dismissed" } })).actorRole).toBe("ADMIN");
    await expect(listAuditLog(db, customer, {})).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("every admin page and admin server action checks the role on the server", async () => {
    const files: string[] = [];
    async function walk(dir: string) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (/^(page\.tsx|actions\.ts|route\.ts)$/.test(entry.name)) files.push(full);
      }
    }
    await walk(path.join(process.cwd(), "app", "admin"));
    expect(files.length).toBeGreaterThan(15);
    const unguarded = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (!/requireAdmin\(|role !== "ADMIN"/.test(source)) unguarded.push(path.relative(process.cwd(), file));
    }
    expect(unguarded).toEqual([]);
  });
});
