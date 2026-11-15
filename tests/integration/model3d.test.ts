import { randomUUID } from "node:crypto";

import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";

import { FakeGarmentModel, FakeImage, FakePhotoChecker, FakePlanner, FakeTryOn } from "@/lib/ai/providers/fake";
import type { AiProviders, GarmentModelProvider } from "@/lib/ai/types";
import { processNextJob, type AiWorkerDeps } from "@/lib/ai/worker/run";
import { ForbiddenError, type Actor } from "@/lib/auth/policy";
import { checkGlb } from "@/lib/model3d/glb";
import { MODEL3D_DAILY_LIMIT, MODEL3D_QUOTA_MESSAGE } from "@/lib/model3d/payload";
import { createGarmentModelJob, getGarmentModelStatus, Model3dError } from "@/lib/model3d/service";
import { BUCKETS } from "@/lib/storage/buckets";
import type { MemoryStorageAdapter } from "@/lib/storage/memory";

import { storageWithTemplateAssets, TEMPLATE, validSpec } from "../fixtures/design";

import { createProduct, createUser, db, resetDatabaseBeforeEach } from "./helpers";

// The 3D view: queueing a model of a ready-made item or a design (owner-scoped, cached, 5 a day), the
// worker making and checking it, and only its owner getting a link to it.

resetDatabaseBeforeEach();

let storage: MemoryStorageAdapter;
beforeEach(async () => {
  storage = await storageWithTemplateAssets();
});

async function customizableProduct() {
  const product = await createProduct({ variants: [{ size: "M", color: "Sage", priceMinor: 320_000, stock: 3 }] });
  const imageKey = `${product.id}/products/${randomUUID()}.webp`;
  await storage.put(BUCKETS.productMedia, imageKey, await sharp({ create: { width: 600, height: 800, channels: 3, background: "#7a9a7a" } }).webp().toBuffer(), "image/webp");
  await db.product.update({ where: { id: product.id }, data: { imageKeys: [imageKey] } });
  const template = await db.customizationTemplate.create({ data: { productId: product.id, version: 2, config: TEMPLATE, isActive: true, aiEnabled: true } });
  const spec = validSpec({ productId: product.id, templateId: template.id, templateVersion: 2 });
  return { product, spec };
}

/** `null`: a worker with no 3D model provider. */
function deps(garmentModel: GarmentModelProvider | null = new FakeGarmentModel()): AiWorkerDeps {
  const providers: AiProviders = { planner: new FakePlanner(), image: new FakeImage(), tryOn: new FakeTryOn(), photoCheck: new FakePhotoChecker(), ...(garmentModel ? { garmentModel } : {}) };
  return { db, storage, providers, workerId: "worker-a", timeoutMs: 10_000, backoffMs: () => 0 };
}

async function expectModelError(promise: Promise<unknown>, code: Model3dError["code"]) {
  await expect(promise).rejects.toSatisfy((e) => e instanceof Model3dError && e.code === code);
}

const ofProduct = (customer: Actor, productId: string) => createGarmentModelJob(db, storage, customer, { source: { kind: "product", productId } });

describe("3D view", () => {
  it("makes a model of a ready-made item, stores it under the customer's models, and links only its owner to it", async () => {
    const customer = await createUser();
    const other = await createUser();
    const { product } = await customizableProduct();
    const { jobId, cached } = await ofProduct(customer, product.id);
    expect(cached).toBe(false);
    expect(await getGarmentModelStatus(db, storage, customer, jobId)).toEqual({ state: "pending", position: "queued" });

    expect(await processNextJob(deps())).toBe(true);
    const job = await db.aIJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("SUCCEEDED");
    const modelKey = (job.result as { modelKey: string }).modelKey;
    expect(modelKey.startsWith(`${customer.id.toLowerCase()}/models/`)).toBe(true);
    expect(modelKey.endsWith(".glb")).toBe(true);
    const stored = await storage.get(BUCKETS.designAssets, modelKey);
    expect(stored && checkGlb(stored).vertices).toBeGreaterThan(0);

    const status = await getGarmentModelStatus(db, storage, customer, jobId);
    expect(status.state).toBe("done");
    // Another customer can't see it: "not found", not "forbidden".
    await expectModelError(getGarmentModelStatus(db, storage, other, jobId), "NOT_FOUND");
    await expectModelError(getGarmentModelStatus(db, storage, customer, "not-a-uuid"), "NOT_FOUND");
  });

  it("hands back a model already made, or one being made, without a new job", async () => {
    const customer = await createUser();
    const { product } = await customizableProduct();
    const first = await ofProduct(customer, product.id);
    expect(await ofProduct(customer, product.id)).toEqual({ jobId: first.jobId, cached: true });
    await processNextJob(deps());
    expect(await ofProduct(customer, product.id)).toEqual({ jobId: first.jobId, cached: true });
    expect(await db.aIJob.count({ where: { type: "GARMENT_MODEL" } })).toBe(1);
  });

  it("makes a model of a design as it is in the editor, revalidated on the server", async () => {
    const customer = await createUser();
    const { spec } = await customizableProduct();
    const { jobId } = await createGarmentModelJob(db, storage, customer, { source: { kind: "design", spec } });
    await processNextJob(deps());
    expect((await db.aIJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("SUCCEEDED");
    await expectModelError(createGarmentModelJob(db, storage, customer, { source: { kind: "design", spec: { ...spec, size: "nonsense" } } }), "INVALID");
    await expectModelError(createGarmentModelJob(db, storage, customer, { source: { kind: "product", productId: randomUUID() } }), "NOT_AVAILABLE");
  });

  it("allows five a day and records the refusal", async () => {
    const customer = await createUser();
    for (let i = 0; i < MODEL3D_DAILY_LIMIT; i += 1) {
      const { product } = await customizableProduct();
      await ofProduct(customer, product.id);
    }
    const { product } = await customizableProduct();
    await expect(ofProduct(customer, product.id)).rejects.toThrow(MODEL3D_QUOTA_MESSAGE);
    expect(await db.aiLimitHit.count({ where: { customerId: customer.id, feature: "GARMENT_MODEL" } })).toBe(1);
  });

  it("is for customers only", async () => {
    const admin = await createUser("ADMIN");
    const { product } = await customizableProduct();
    await expect(ofProduct(admin, product.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("stores nothing a provider returns that isn't a self-contained model, and fails without a provider", async () => {
    const customer = await createUser();
    const { product } = await customizableProduct();
    const broken: GarmentModelProvider = { name: "broken", buildModel: async () => Buffer.from("not a model") };
    const { jobId } = await ofProduct(customer, product.id);
    await processNextJob(deps(broken));
    const retried = await db.aIJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(retried.status).toBe("QUEUED");
    expect(retried.errorCode).toBe("PROVIDER");
    expect([...storage.objects.keys()].some((k) => k.includes("/models/"))).toBe(false);

    await db.aIJob.update({ where: { id: jobId }, data: { runAfter: new Date(0) } });
    await processNextJob(deps(null));
    expect(await getGarmentModelStatus(db, storage, customer, jobId)).toEqual({ state: "failed", message: "This garment can't be shown in 3D right now." });
  });
});
