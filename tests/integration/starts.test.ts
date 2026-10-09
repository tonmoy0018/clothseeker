import { randomUUID } from "node:crypto";

import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";

import { AiError, BRAND_LOGO_MESSAGE } from "@/lib/ai/errors";
import { FAKE_LOGO_MARKER, FakeImage, FakePlanner, FakeTryOn } from "@/lib/ai/fake";
import { getJobStatus } from "@/lib/ai/jobs";
import { QUOTA_MESSAGE } from "@/lib/ai/quota";
import { getStartStatus, startDesignFrom, uploadReferencePhoto } from "@/lib/ai/starts";
import type { AiProviders, PlannerProvider } from "@/lib/ai/types";
import { processNextJob, runAiJobs, type AiWorkerDeps } from "@/lib/ai/worker/run";
import type { Actor } from "@/lib/auth/policy";
import { DesignError, saveDesign } from "@/lib/design/service";
import { validateDesignAgainstTemplate } from "@/lib/design/validate";
import type { MemoryStorageAdapter } from "@/lib/storage/memory";
import { parseDesignSpec } from "@/types/design-spec";

import { storageWithTemplateAssets, TEMPLATE, validSpec } from "../fixtures/design";

import { createProduct, createUser, db, resetDatabaseBeforeEach } from "./helpers";

resetDatabaseBeforeEach();

let storage: MemoryStorageAdapter;
beforeEach(async () => {
  storage = await storageWithTemplateAssets();
});

async function customizable(name: string, description: string, aiEnabled = true) {
  const product = await createProduct({ variants: [{ size: "M", color: "Sage", priceMinor: 320_000, stock: 3 }] });
  await db.product.update({ where: { id: product.id }, data: { name, description } });
  const template = await db.customizationTemplate.create({ data: { productId: product.id, version: 1, config: TEMPLATE, isActive: true, aiEnabled } });
  return { product, template };
}

function deps(planner: PlannerProvider = new FakePlanner()): AiWorkerDeps {
  const providers: AiProviders = { planner, image: new FakeImage(), tryOn: new FakeTryOn() };
  return { db, storage, providers, workerId: "worker-a", timeoutMs: 10_000, backoffMs: () => 0 };
}

async function dressPhoto(hex: string) {
  return sharp({ create: { width: 500, height: 700, channels: 3, background: hex } }).jpeg().toBuffer();
}

async function expectAiError(promise: Promise<unknown>, code: AiError["code"], message?: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AiError);
  if (error instanceof AiError) {
    expect(error.code).toBe(code);
    if (message) expect(error.message).toBe(message);
  }
}

async function finished(customer: Actor, jobId: string) {
  const status = await getStartStatus(db, customer, jobId);
  if (status.state !== "done") throw new Error(`expected done, got ${JSON.stringify(status)}`);
  return status.result;
}

describe("start from a dress photo", () => {
  it("matches a customizable dress and prefills a draft with the photo's color and the reference photo", async () => {
    const customer = await createUser();
    await customizable("Wrap Dress", "A soft wrap dress");
    await customizable("Tiered Midi", "A tiered midi dress");
    const photo = await uploadReferencePhoto(storage, customer, await dressPhoto("#1f6f50"));
    expect(photo.key.startsWith(`${customer.id}/references/`)).toBe(true);

    const { jobId } = await startDesignFrom(db, storage, customer, { mode: "photo", referenceKey: photo.key });
    expect(await getStartStatus(db, customer, jobId)).toEqual({ state: "pending", position: "queued" });
    await processNextJob(deps());
    const result = await finished(customer, jobId);

    const design = await db.design.findUniqueOrThrow({ where: { id: result.designId } });
    expect(design).toMatchObject({ customerId: customer.id, productId: result.productId, status: "DRAFT", startedFrom: "PHOTO", referencePhotoKey: photo.key });
    const spec = parseDesignSpec(design.spec);
    expect(spec.startedFrom).toBe("photo");
    expect(spec.referencePhotoKey).toBe(photo.key);
    // The photo's dark green maps to the template's Emerald on every recolorable region.
    expect(Object.values(spec.parts).map((p) => p.color)).toContain("#1f6f50");
    const template = await db.customizationTemplate.findFirstOrThrow({ where: { productId: result.productId } });
    expect(validateDesignAgainstTemplate(spec, TEMPLATE, { productId: result.productId, templateId: template.id, availableSizes: ["M"], customerId: customer.id })).toEqual([]);
    expect(result.alternatives).not.toContain(result.productId);
    expect(result.roundJobId).toBeNull();
  });

  it("rejects photos with a clothing brand logo and flags them", async () => {
    const customer = await createUser();
    await customizable("Wrap Dress", "A soft wrap dress");
    const photo = await uploadReferencePhoto(storage, customer, await dressPhoto(FAKE_LOGO_MARKER));
    const { jobId } = await startDesignFrom(db, storage, customer, { mode: "photo", referenceKey: photo.key });
    await runAiJobs(deps());
    expect(await getStartStatus(db, customer, jobId)).toEqual({ state: "failed", message: BRAND_LOGO_MESSAGE, code: "BRAND_LOGO" });
    expect(await db.flaggedItem.findFirstOrThrow()).toMatchObject({ kind: "BRAND_LOGO", customerId: customer.id, aiJobId: jobId, storageKey: photo.key });
    expect(await db.design.count()).toBe(0);
  });

  it("only accepts the customer's own existing photos", async () => {
    const alice = await createUser();
    const bob = await createUser();
    await customizable("Wrap Dress", "A soft wrap dress");
    const alicePhoto = await uploadReferencePhoto(storage, alice, await dressPhoto("#1f6f50"));
    await expectAiError(startDesignFrom(db, storage, bob, { mode: "photo", referenceKey: alicePhoto.key }), "INVALID");
    await expectAiError(startDesignFrom(db, storage, alice, { mode: "photo", referenceKey: `${alice.id}/references/${randomUUID()}.webp` }), "INVALID");
    expect(await db.aIJob.count()).toBe(0);
  });

  it("a design can't point at someone else's reference photo", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const { product, template } = await customizable("Wrap Dress", "A soft wrap dress");
    const alicePhoto = await uploadReferencePhoto(storage, alice, await dressPhoto("#1f6f50"));
    const spec = validSpec({ productId: product.id, templateId: template.id, size: "M", startedFrom: "photo", referencePhotoKey: alicePhoto.key });
    await saveDesign(db, storage, alice, { spec });
    await expect(saveDesign(db, storage, bob, { spec })).rejects.toBeInstanceOf(DesignError);
  });

  it("retries when the planner picks a dress it wasn't offered, then fails", async () => {
    const customer = await createUser();
    await customizable("Wrap Dress", "A soft wrap dress");
    const photo = await uploadReferencePhoto(storage, customer, await dressPhoto("#1f6f50"));
    const inner = new FakePlanner();
    const rogue: PlannerProvider = {
      name: "rogue",
      detectBrandLogos: (i, s) => inner.detectBrandLogos(i, s),
      checkTryOnPhoto: (i, s) => inner.checkTryOnPhoto(i, s),
      planDesign: (r, s) => inner.planDesign(r, s),
      matchDress: async () => ({ productId: randomUUID(), alternatives: [] }),
    };
    const { jobId } = await startDesignFrom(db, storage, customer, { mode: "photo", referenceKey: photo.key });
    await runAiJobs(deps(rogue));
    await runAiJobs(deps(rogue));
    await runAiJobs(deps(rogue));
    expect(await getStartStatus(db, customer, jobId)).toMatchObject({ state: "failed", code: "INVALID_PLAN" });
    expect(await db.aIJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ attempts: 3 });
    expect(await db.design.count()).toBe(0);
  });
});

describe("start from a description", () => {
  it("picks the dress that fits the words and starts an AI design round on it", async () => {
    const customer = await createUser();
    await customizable("Linen Wrap Dress", "A breezy wrap dress in linen");
    const { product: tiered } = await customizable("Cotton Tiered Midi", "A tiered cotton midi for summer");
    await customizable("Not For AI", "A tiered cotton midi", false);

    const { jobId } = await startDesignFrom(db, storage, customer, { mode: "description", description: "A tiered cotton midi in emerald for a summer wedding" });
    await processNextJob(deps());
    const result = await finished(customer, jobId);
    expect(result.productId).toBe(tiered.id);
    expect(result.roundJobId).not.toBeNull();

    const design = await db.design.findUniqueOrThrow({ where: { id: result.designId } });
    expect(design).toMatchObject({ startedFrom: "DESCRIPTION", status: "DRAFT", referencePhotoKey: null });
    expect(Object.values(parseDesignSpec(design.spec).parts).map((p) => p.color)).toContain("#1f6f50");

    // The queued round runs on the new design.
    await processNextJob(deps());
    const round = await getJobStatus(db, storage, customer, result.roundJobId);
    expect(round.state).toBe("done");
    if (round.state === "done") expect(round.round.designId).toBe(result.designId);
  });

  it("refuses brand names, needs a round left today, and reuses identical requests", async () => {
    const customer = await createUser();
    await customizable("Linen Wrap Dress", "A breezy wrap dress in linen");
    await expectAiError(startDesignFrom(db, storage, customer, { mode: "description", description: "Something like the Gucci summer dress" }), "BRAND_LOGO", BRAND_LOGO_MESSAGE);
    await expectAiError(startDesignFrom(db, storage, customer, { mode: "description", description: "short" }), "INVALID");

    const first = await startDesignFrom(db, storage, customer, { mode: "description", description: "A breezy linen wrap dress" });
    expect(await startDesignFrom(db, storage, customer, { mode: "description", description: "  a BREEZY linen   wrap dress " })).toEqual({ jobId: first.jobId, cached: true });

    const design = await db.design.create({ data: { customerId: customer.id, productId: (await db.product.findFirstOrThrow()).id, spec: {}, status: "DRAFT" } });
    for (let i = 0; i < 10; i++) {
      const job = await db.aIJob.create({ data: { type: "DESIGN_ROUND", status: "SUCCEEDED", customerId: customer.id, payload: {}, inputHash: randomUUID() } });
      await db.aIRound.create({ data: { designId: design.id, customerId: customer.id, instruction: "x", inputHash: randomUUID(), jobId: job.id } });
    }
    await expectAiError(startDesignFrom(db, storage, customer, { mode: "description", description: "A long flowing maxi for evenings" }), "QUOTA", QUOTA_MESSAGE);
  });

  it("other customers can't see a start request", async () => {
    const alice = await createUser();
    const bob = await createUser();
    await customizable("Linen Wrap Dress", "A breezy wrap dress in linen");
    const { jobId } = await startDesignFrom(db, storage, alice, { mode: "description", description: "A breezy linen wrap dress" });
    await expectAiError(getStartStatus(db, bob, jobId), "NOT_FOUND");
  });
});
