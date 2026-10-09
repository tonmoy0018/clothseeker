import { randomUUID } from "node:crypto";

import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";

import { ForbiddenError, type Actor } from "@/lib/auth/policy";
import { AiError, AiProviderError, BRAND_LOGO_MESSAGE } from "@/lib/ai/errors";
import { FAKE_LOGO_MARKER, FakeImage, FakePlanner, FakeTryOn } from "@/lib/ai/fake";
import { createDesignRoundJob, getAiQuota, getJobStatus, listRounds, pickOption, uploadAiAttachment, type DesignRoundRequest } from "@/lib/ai/jobs";
import { QUOTA_MESSAGE } from "@/lib/ai/quota";
import { storedOptionsSchema } from "@/lib/ai/rounds";
import type { AiProviders, PlannerProvider, PlanRequest } from "@/lib/ai/types";
import { claimNextJob } from "@/lib/ai/worker/claim";
import { processNextJob, recoverStuckJobs, runAiJobs, type AiWorkerDeps } from "@/lib/ai/worker/run";
import { listDesigns, saveDesign } from "@/lib/design/service";
import { validateDesignAgainstTemplate } from "@/lib/design/validate";
import { BUCKETS } from "@/lib/storage/buckets";
import type { MemoryStorageAdapter } from "@/lib/storage/memory";
import { parseDesignSpec, type DesignSpec } from "@/types/design-spec";

import { storageWithTemplateAssets, TEMPLATE, validSpec } from "../fixtures/design";

import { createProduct, createUser, db, resetDatabaseBeforeEach } from "./helpers";

resetDatabaseBeforeEach();

let storage: MemoryStorageAdapter;
beforeEach(async () => {
  storage = await storageWithTemplateAssets();
});

async function customizableProduct(aiEnabled = true) {
  const product = await createProduct({
    variants: [
      { size: "M", color: "Sage", priceMinor: 320_000, stock: 3 },
      { size: "L", color: "Sage", priceMinor: 330_000, stock: 3 },
    ],
  });
  const template = await db.customizationTemplate.create({
    data: { productId: product.id, version: 2, config: TEMPLATE, isActive: true, aiEnabled },
  });
  const spec = validSpec({ productId: product.id, templateId: template.id, templateVersion: 2 });
  return { product, template, spec };
}

/** Records the requests a planner receives, delegating to the fake. */
class SpyPlanner implements PlannerProvider {
  readonly name = "spy";
  readonly requests: PlanRequest[] = [];
  private readonly inner = new FakePlanner();

  constructor(private readonly behaviour: (attempt: number, signal: AbortSignal) => Promise<void> = async () => undefined) {}

  detectBrandLogos: PlannerProvider["detectBrandLogos"] = (images, signal) => this.inner.detectBrandLogos(images, signal);
  checkTryOnPhoto: PlannerProvider["checkTryOnPhoto"] = (image, signal) => this.inner.checkTryOnPhoto(image, signal);
  matchDress: PlannerProvider["matchDress"] = (request, signal) => this.inner.matchDress(request, signal);

  async planDesign(request: PlanRequest, signal: AbortSignal): Promise<unknown> {
    this.requests.push(request);
    await this.behaviour(this.requests.length, signal);
    return this.inner.planDesign(request, signal);
  }
}

function deps(providers: Partial<AiProviders> = {}, overrides: Partial<AiWorkerDeps> = {}): AiWorkerDeps {
  return {
    db,
    storage,
    providers: { planner: new FakePlanner(), image: new FakeImage(), tryOn: new FakeTryOn(), ...providers },
    workerId: "worker-a",
    timeoutMs: 10_000,
    backoffMs: () => 0,
    ...overrides,
  };
}

async function expectAiError(promise: Promise<unknown>, code: AiError["code"], message?: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AiError);
  if (error instanceof AiError) {
    expect(error.code).toBe(code);
    if (message) {
      expect(error.message).toBe(message);
    }
  }
}

async function request(customer: Actor, spec: DesignSpec, extra: Partial<DesignRoundRequest> = {}) {
  return createDesignRoundJob(db, storage, customer, { spec, instruction: "Pastel florals on the skirt", ...extra });
}

async function photo(hex: string) {
  return sharp({ create: { width: 400, height: 300, channels: 3, background: hex } }).jpeg().toBuffer();
}

/** Finished rounds made directly in the database (for quota tests). */
async function seedRounds(customer: Actor, designId: string, count: number, createdAt = new Date()) {
  for (let i = 0; i < count; i++) {
    const job = await db.aIJob.create({ data: { type: "DESIGN_ROUND", status: "SUCCEEDED", customerId: customer.id, payload: {}, inputHash: randomUUID(), createdAt } });
    await db.aIRound.create({ data: { designId, customerId: customer.id, instruction: "x", inputHash: randomUUID(), jobId: job.id, createdAt } });
  }
}

describe("creating AI design rounds", () => {
  it("queues a job for a valid request and saves an unsaved design as a hidden draft", async () => {
    const customer = await createUser();
    const { spec } = await customizableProduct();

    const queued = await request(customer, spec);
    expect(queued.cached).toBe(false);
    const job = await db.aIJob.findUniqueOrThrow({ where: { id: queued.jobId } });
    expect(job).toMatchObject({ status: "QUEUED", type: "DESIGN_ROUND", customerId: customer.id, attempts: 0 });
    const design = await db.design.findUniqueOrThrow({ where: { id: queued.designId } });
    expect(design.status).toBe("DRAFT");
    expect(await listDesigns(db, storage, customer)).toHaveLength(0);
    expect(await getJobStatus(db, storage, customer, queued.jobId)).toEqual({ state: "pending", position: "queued" });
    expect(await getAiQuota(db, customer)).toEqual({ used: 1, limit: 10, remaining: 9 });
  });

  it("invalid requests create nothing and use no quota", async () => {
    const customer = await createUser();
    const admin = await createUser("ADMIN");
    const other = await createUser();
    const { spec } = await customizableProduct();

    await expectAiError(request(customer, spec, { instruction: "hi" }), "INVALID");
    await expectAiError(request(customer, spec, { instruction: "x".repeat(501) }), "INVALID");
    await expectAiError(request(customer, { ...spec, size: "XS" }), "INVALID");
    await expectAiError(request(customer, spec, { attachmentKeys: ["a", "b", "c", "d"] }), "INVALID");
    const theirs = await uploadAiAttachment(storage, other, await photo("#336699"));
    await expectAiError(request(customer, spec, { attachmentKeys: [theirs.key] }), "INVALID", "One of the attached photos isn't yours.");
    await expectAiError(request(customer, spec, { attachmentKeys: [`${customer.id}/ai-inputs/${randomUUID()}.webp`] }), "INVALID");
    await expectAiError(request(customer, spec, { reference: { roundId: randomUUID(), optionIndex: 0 } }), "NOT_FOUND");
    await expectAiError(request(customer, spec, { designId: randomUUID() }), "NOT_FOUND");
    await expect(request(admin, spec)).rejects.toBeInstanceOf(ForbiddenError);

    expect(await db.aIJob.count()).toBe(0);
    expect(await db.design.count()).toBe(0);
    expect((await getAiQuota(db, customer)).used).toBe(0);
  });

  it("rejects brand names before using quota, with the exact message", async () => {
    const customer = await createUser();
    const { spec } = await customizableProduct();
    await expectAiError(request(customer, spec, { instruction: "add a Nike logo on the chest" }), "BRAND_LOGO", BRAND_LOGO_MESSAGE);
    expect(await db.aIJob.count()).toBe(0);
  });

  it("is only available for templates with AI switched on", async () => {
    const customer = await createUser();
    const { spec } = await customizableProduct(false);
    await expectAiError(request(customer, spec), "NOT_AVAILABLE");
  });

  it("allows 10 rounds per Dhaka day, counting requests still in progress", async () => {
    const customer = await createUser();
    const { spec } = await customizableProduct();
    const first = await request(customer, spec, { instruction: "round one" });
    await seedRounds(customer, first.designId, 3, new Date(Date.now() - 36 * 60 * 60 * 1000)); // yesterday: don't count
    await seedRounds(customer, first.designId, 8);
    // 8 finished + 1 queued = 9 → one more is allowed.
    await request(customer, spec, { instruction: "round ten", designId: first.designId });
    await expectAiError(request(customer, spec, { instruction: "round eleven", designId: first.designId }), "QUOTA", QUOTA_MESSAGE);
    expect(await getAiQuota(db, customer)).toEqual({ used: 10, limit: 10, remaining: 0 });

    // A failed request gives its round back.
    await db.aIJob.update({ where: { id: first.jobId }, data: { status: "FAILED" } });
    await request(customer, spec, { instruction: "round eleven", designId: first.designId });
  });

  it("concurrent requests can't slip past the quota", async () => {
    const customer = await createUser();
    const { spec } = await customizableProduct();
    const first = await request(customer, spec, { instruction: "round one" });
    await seedRounds(customer, first.designId, 7);
    const results = await Promise.allSettled(
      [1, 2, 3, 4].map((i) => request(customer, spec, { instruction: `parallel ${i}`, designId: first.designId })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect((await getAiQuota(db, customer)).used).toBe(10);
  });
});

describe("running AI jobs", () => {
  it("makes a round of up to 4 template-valid options with stored previews", async () => {
    const customer = await createUser();
    const { product, spec } = await customizableProduct();
    const queued = await request(customer, spec, { instruction: 'Make it evening-ready in emerald with "Ava" on it' });

    expect(await processNextJob(deps())).toBe(true);

    const status = await getJobStatus(db, storage, customer, queued.jobId);
    if (status.state !== "done") throw new Error(`expected done, got ${status.state}`);
    expect(status.round.options).toHaveLength(4);
    expect(status.round.options.every((o) => o.previewUrl?.startsWith("memory://design-assets/"))).toBe(true);

    const round = await db.aIRound.findUniqueOrThrow({ where: { id: status.round.id } });
    expect(round).toMatchObject({ designId: queued.designId, customerId: customer.id, jobId: queued.jobId, generation: 0 });
    for (const key of round.optionKeys) {
      expect(key.startsWith(`${customer.id}/ai/`)).toBe(true);
      expect(storage.has(BUCKETS.designAssets, key)).toBe(true);
    }
    const options = storedOptionsSchema.parse(round.options);
    for (const option of options) {
      const optionSpec = parseDesignSpec(option.spec);
      const ctx = { productId: product.id, templateId: spec.templateId, availableSizes: ["M", "L"] as const, customerId: customer.id };
      expect(validateDesignAgainstTemplate(optionSpec, TEMPLATE, { ...ctx, availableSizes: [...ctx.availableSizes] })).toEqual([]);
      if (option.motifKey) {
        expect(storage.has(BUCKETS.designAssets, option.motifKey)).toBe(true);
      }
    }
    const job = await db.aIJob.findUniqueOrThrow({ where: { id: queued.jobId } });
    expect(job).toMatchObject({ status: "SUCCEEDED", attempts: 1, lockedBy: null, result: { roundId: round.id } });
    expect(await processNextJob(deps())).toBe(false);
  });

  it("hands back cached results for the same request with no provider call or quota", async () => {
    const customer = await createUser();
    const { spec } = await customizableProduct();
    const planner = new SpyPlanner();
    const first = await request(customer, spec);
    // A double-click while the first is still queued gets the same job.
    expect(await request(customer, spec, { instruction: "  pastel   FLORALS on the skirt " })).toEqual({ ...first, cached: true });
    await processNextJob(deps({ planner }));

    const again = await request(customer, spec, { designId: first.designId });
    expect(again).toEqual({ jobId: first.jobId, designId: first.designId, cached: true });
    expect(await db.aIJob.count()).toBe(1);
    expect(planner.requests).toHaveLength(1);
    expect((await getAiQuota(db, customer)).used).toBe(1);

    // "Generate again" asks for fresh results.
    const fresh = await request(customer, spec, { designId: first.designId, again: true });
    expect(fresh.cached).toBe(false);
    await processNextJob(deps({ planner }));
    expect(planner.requests).toHaveLength(2);
    expect(planner.requests[1]?.seed).not.toBe(planner.requests[0]?.seed);
    expect((await listRounds(db, storage, customer, first.designId)).map((r) => r.id)).toHaveLength(2);
  });

  it("a fresh editor never gets a saved design handed back by the cache", async () => {
    const customer = await createUser();
    const { spec } = await customizableProduct();
    const first = await request(customer, spec);
    await processNextJob(deps());
    await saveDesign(db, storage, customer, { designId: first.designId, spec });

    // Same words and design, but no design open: a new draft, not the saved design (which Save would overwrite).
    const again = await request(customer, spec);
    expect(again.designId).not.toBe(first.designId);
    expect(again.cached).toBe(false);
    expect(await db.design.findUniqueOrThrow({ where: { id: again.designId } })).toMatchObject({ status: "DRAFT" });
    // With the saved design open, the cache still applies.
    expect(await request(customer, spec, { designId: first.designId })).toEqual({ jobId: first.jobId, designId: first.designId, cached: true });
  });

  it("two workers never claim the same job", async () => {
    const customer = await createUser();
    const { spec } = await customizableProduct();
    const jobs = [];
    for (let i = 0; i < 5; i++) {
      jobs.push((await request(customer, spec, { instruction: `job number ${i}` })).jobId);
    }
    const claims = await Promise.all(Array.from({ length: 12 }, (_, i) => claimNextJob(db, `worker-${i}`, new Date())));
    const claimed = claims.flatMap((c) => (c ? [c.id] : []));
    expect(claimed).toHaveLength(5);
    expect(new Set(claimed)).toEqual(new Set(jobs));
    expect(await db.aIJob.count({ where: { status: "RUNNING", attempts: 1 } })).toBe(5);
  });

  it("retries transient failures twice, then fails with a friendly message", async () => {
    const customer = await createUser();
    const { spec } = await customizableProduct();
    const queued = await request(customer, spec);
    const planner = new SpyPlanner(async () => {
      throw new AiProviderError("rate limited", true);
    });

    const at = new Date();
    await processNextJob(deps({ planner }, { now: () => at, backoffMs: (n) => n * 1000 }));
    let job = await db.aIJob.findUniqueOrThrow({ where: { id: queued.jobId } });
    expect(job).toMatchObject({ status: "QUEUED", attempts: 1, errorCode: "PROVIDER", lockedBy: null });
    expect(job.runAfter.getTime()).toBe(at.getTime() + 1000);
    // Not due yet.
    expect(await processNextJob(deps({ planner }, { now: () => at }))).toBe(false);

    const later = () => new Date(at.getTime() + 60_000);
    await processNextJob(deps({ planner }, { now: later }));
    await processNextJob(deps({ planner }, { now: later }));
    job = await db.aIJob.findUniqueOrThrow({ where: { id: queued.jobId } });
    expect(job).toMatchObject({ status: "FAILED", attempts: 3, errorCode: "PROVIDER" });
    expect(planner.requests).toHaveLength(3);
    const status = await getJobStatus(db, storage, customer, queued.jobId);
    expect(status).toMatchObject({ state: "failed", code: "PROVIDER" });
    expect(await db.aIRound.count()).toBe(0);
    expect((await getAiQuota(db, customer)).used).toBe(0);
  });

  it("doesn't retry requests that will fail the same way again", async () => {
    const customer = await createUser();
    const { spec } = await customizableProduct();
    const queued = await request(customer, spec);
    const planner = new SpyPlanner(async () => {
      throw new AiProviderError("bad request", false);
    });
    await runAiJobs(deps({ planner }));
    expect(await db.aIJob.findUniqueOrThrow({ where: { id: queued.jobId } })).toMatchObject({ status: "FAILED", attempts: 1 });
  });

  it("times out a hung attempt, then succeeds on retry, leaving no stray files", async () => {
    const customer = await createUser();
    const { spec } = await customizableProduct();
    const queued = await request(customer, spec);
    const filesBefore = storage.objects.size;
    const planner = new SpyPlanner(async (attempt, signal) => {
      if (attempt === 1) {
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
      }
    });

    await processNextJob(deps({ planner }, { timeoutMs: 100 }));
    expect(await db.aIJob.findUniqueOrThrow({ where: { id: queued.jobId } })).toMatchObject({ status: "QUEUED", attempts: 1, errorCode: "TIMEOUT" });
    expect(storage.objects.size).toBe(filesBefore);

    await processNextJob(deps({ planner }));
    expect(await db.aIJob.findUniqueOrThrow({ where: { id: queued.jobId } })).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
  });

  it("a refused motif costs the option its motif, not the round", async () => {
    const customer = await createUser();
    const { spec } = await customizableProduct();
    const queued = await request(customer, spec);
    const image = {
      name: "refusing",
      generateMotif: async () => {
        throw new AiProviderError("cloudflare returned HTTP 400", false);
      },
    };
    await processNextJob(deps({ image }));
    const status = await getJobStatus(db, storage, customer, queued.jobId);
    if (status.state !== "done") throw new Error(`expected done, got ${status.state}`);
    const round = await db.aIRound.findUniqueOrThrow({ where: { id: status.round.id } });
    const options = storedOptionsSchema.parse(round.options);
    expect(options.length).toBeGreaterThan(0);
    expect(options.every((o) => o.motifKey === null && !parseDesignSpec(o.spec).layers.some((l) => l.kind === "image"))).toBe(true);
  });

  it("an unusable motif image costs the option its motif, not the round", async () => {
    const customer = await createUser();
    const { spec } = await customizableProduct();
    const queued = await request(customer, spec);
    const junk = { name: "junk", generateMotif: async () => Buffer.from("not an image") };
    await processNextJob(deps({ image: junk }));
    const status = await getJobStatus(db, storage, customer, queued.jobId);
    expect(status.state).toBe("done");
  });

  it("recovers jobs whose worker died", async () => {
    const customer = await createUser();
    const { spec } = await customizableProduct();
    const a = await request(customer, spec, { instruction: "job a" });
    const b = await request(customer, spec, { instruction: "job b" });
    const old = new Date(Date.now() - 10 * 60_000);
    await db.aIJob.update({ where: { id: a.jobId }, data: { status: "RUNNING", lockedAt: old, lockedBy: "dead", attempts: 1 } });
    await db.aIJob.update({ where: { id: b.jobId }, data: { status: "RUNNING", lockedAt: old, lockedBy: "dead", attempts: 3 } });

    expect(await recoverStuckJobs(db, new Date(), 60_000)).toBe(2);
    expect(await db.aIJob.findUniqueOrThrow({ where: { id: a.jobId } })).toMatchObject({ status: "QUEUED", lockedBy: null });
    expect(await db.aIJob.findUniqueOrThrow({ where: { id: b.jobId } })).toMatchObject({ status: "FAILED", errorCode: "TIMEOUT" });
    // A fresh lease is left alone.
    await db.aIJob.update({ where: { id: a.jobId }, data: { status: "RUNNING", lockedAt: new Date(), lockedBy: "alive" } });
    expect(await recoverStuckJobs(db, new Date(), 60_000)).toBe(0);
  });

  it("rejects photos with a clothing brand logo and flags them for the team", async () => {
    const customer = await createUser();
    const { spec } = await customizableProduct();
    const logo = await uploadAiAttachment(storage, customer, await photo(FAKE_LOGO_MARKER));
    expect(logo.key.startsWith(`${customer.id}/ai-inputs/`)).toBe(true);
    const queued = await request(customer, spec, { attachmentKeys: [logo.key] });

    await runAiJobs(deps());
    expect(await getJobStatus(db, storage, customer, queued.jobId)).toEqual({ state: "failed", message: BRAND_LOGO_MESSAGE, code: "BRAND_LOGO" });
    expect(await db.aIJob.findUniqueOrThrow({ where: { id: queued.jobId } })).toMatchObject({ status: "FAILED", attempts: 1 });
    const flag = await db.flaggedItem.findFirstOrThrow();
    expect(flag).toMatchObject({ kind: "BRAND_LOGO", status: "OPEN", customerId: customer.id, aiJobId: queued.jobId, storageKey: logo.key });
  });

  it("passes ordinary photos to the planner", async () => {
    const customer = await createUser();
    const { spec } = await customizableProduct();
    const inspiration = await uploadAiAttachment(storage, customer, await photo("#336699"));
    const planner = new SpyPlanner();
    await request(customer, spec, { attachmentKeys: [inspiration.key] });
    await runAiJobs(deps({ planner }));
    expect(planner.requests[0]?.images).toHaveLength(1);
    expect(await db.aIRound.count()).toBe(1);
  });

  it("fails cleanly when the dress stops being AI-enabled before the job runs", async () => {
    const customer = await createUser();
    const { template, spec } = await customizableProduct();
    const queued = await request(customer, spec);
    await db.customizationTemplate.update({ where: { id: template.id }, data: { aiEnabled: false } });
    await runAiJobs(deps());
    expect(await getJobStatus(db, storage, customer, queued.jobId)).toMatchObject({ state: "failed", code: "NOT_AVAILABLE" });
  });
});

describe("using results", () => {
  async function finishedRound(customer: Actor, spec: DesignSpec, planner: PlannerProvider = new FakePlanner()) {
    const queued = await request(customer, spec, { instruction: "Make it evening-ready in emerald" });
    await processNextJob(deps({ planner }));
    const status = await getJobStatus(db, storage, customer, queued.jobId);
    if (status.state !== "done") throw new Error("round not done");
    return { ...queued, round: status.round };
  }

  it("picking an option returns a valid, priced spec and remembers the choice", async () => {
    const customer = await createUser();
    const { spec } = await customizableProduct();
    const { round, designId } = await finishedRound(customer, spec);

    const picked = await pickOption(db, storage, customer, { roundId: round.id, optionIndex: 2 });
    expect(picked.spec.productId).toBe(spec.productId);
    expect(picked.price.totalMinor).toBeGreaterThan(0);
    const motif = picked.spec.layers.find((l) => l.kind === "image");
    if (motif?.kind === "image") {
      expect(picked.imageUrls[motif.image.assetKey]).toMatch(/^memory:\/\//);
    }
    expect((await listRounds(db, storage, customer, designId))[0]?.chosenIndex).toBe(2);
    await expectAiError(pickOption(db, storage, customer, { roundId: round.id, optionIndex: 3 + 1 }), "NOT_FOUND");
  });

  it("a follow-up sends the referenced option to the planner", async () => {
    const customer = await createUser();
    const { spec } = await customizableProduct();
    const planner = new SpyPlanner();
    const { round, designId } = await finishedRound(customer, spec, planner);
    const picked = await pickOption(db, storage, customer, { roundId: round.id, optionIndex: 1 });

    await request(customer, picked.spec, { designId, instruction: "Like option 2 but darker", reference: { roundId: round.id, optionIndex: 1 } });
    await processNextJob(deps({ planner }));
    const followUp = planner.requests[1];
    const stored = storedOptionsSchema.parse((await db.aIRound.findUniqueOrThrow({ where: { id: round.id } })).options)[1];
    expect(followUp?.reference?.parts).toEqual(Object.entries(parseDesignSpec(stored?.spec).parts).map(([regionId, part]) => ({ regionId, color: part.color, pattern: part.pattern ?? null })));
    expect(await db.aIRound.count()).toBe(2);
  });

  it("other customers can't poll, list, pick or reference a round", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const { spec } = await customizableProduct();
    const { round, jobId, designId } = await finishedRound(alice, spec);

    await expectAiError(getJobStatus(db, storage, bob, jobId), "NOT_FOUND");
    expect(await listRounds(db, storage, bob, designId)).toEqual([]);
    await expectAiError(pickOption(db, storage, bob, { roundId: round.id, optionIndex: 0 }), "NOT_FOUND");
    await expectAiError(request(bob, spec, { reference: { roundId: round.id, optionIndex: 0 } }), "NOT_FOUND");
    await expectAiError(request(bob, spec, { designId }), "NOT_FOUND");
  });
});
