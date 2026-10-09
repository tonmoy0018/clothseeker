import { randomUUID } from "node:crypto";

import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";

import { AiProviderError, AI_FAILURE_MESSAGES } from "@/lib/ai/errors";
import { FakeImage, FakePlanner, FakeTryOn } from "@/lib/ai/fake";
import type { AiProviders, TryOnProvider } from "@/lib/ai/types";
import { processNextJob, runAiJobs, type AiWorkerDeps } from "@/lib/ai/worker/run";
import { ForbiddenError, type Actor } from "@/lib/auth/policy";
import { BUCKETS } from "@/lib/storage/buckets";
import type { MemoryStorageAdapter } from "@/lib/storage/memory";
import { designSignature, TRYON_QUOTA_MESSAGE } from "@/lib/tryon/rules";
import {
  cleanupTryOnMedia,
  createTryOnJob,
  deleteTryOnPhoto,
  getTryOnQuota,
  getTryOnStatus,
  listTryOnPhotos,
  setTryOnPhotoSaved,
  setTryOnResultSaved,
  TryOnError,
  uploadTryOnPhoto,
} from "@/lib/tryon/service";
import type { DesignSpec } from "@/types/design-spec";

import { storageWithTemplateAssets, TEMPLATE, validSpec } from "../fixtures/design";

import { createProduct, createUser, db, resetDatabaseBeforeEach } from "./helpers";

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

/** A portrait "photo" of the given grey level (the fake check rejects mean brightness < 60). */
function photo(grey = 140, width = 600, height = 900) {
  return sharp({ create: { width, height, channels: 3, background: { r: grey, g: grey, b: grey } } }).jpeg().toBuffer();
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

async function expectTryOnError(promise: Promise<unknown>, code: TryOnError["code"]) {
  await expect(promise).rejects.toSatisfy((e) => e instanceof TryOnError && e.code === code);
}

async function uploaded(customer: Actor, grey = 140) {
  return uploadTryOnPhoto(db, storage, customer, { bytes: await photo(grey), consent: "yes" });
}

async function tryOnDesign(customer: Actor, photoId: string, spec: DesignSpec) {
  return createTryOnJob(db, storage, customer, { photoId, source: { kind: "design", spec } });
}

describe("consent and photos", () => {
  it("refuses uploads without explicit consent and stores nothing", async () => {
    const customer = await createUser();
    for (const consent of [undefined, "no", true, "YES"]) {
      await expectTryOnError(uploadTryOnPhoto(db, storage, customer, { bytes: await photo(), consent }), "CONSENT_REQUIRED");
    }
    expect(await db.tryOnPhoto.count()).toBe(0);
    expect([...storage.objects.keys()].some((k) => k.startsWith(BUCKETS.tryonPrivate))).toBe(false);
  });

  it("stores a consented photo privately, re-encoded, with the consent time", async () => {
    const customer = await createUser();
    const now = new Date("2026-10-09T08:00:00Z");
    const view = await uploadTryOnPhoto(db, storage, customer, { bytes: await photo(), consent: "yes" }, now);
    const row = await db.tryOnPhoto.findUniqueOrThrow({ where: { id: view.id } });
    expect(row).toMatchObject({ customerId: customer.id, saved: false, consentAt: now, deletedAt: null });
    expect(row.storageKey.startsWith(`${customer.id}/photos/`)).toBe(true);
    expect((await sharp(storage.objects.get(`${BUCKETS.tryonPrivate}/${row.storageKey}`)?.data).metadata()).format).toBe("webp");
    expect(view.expiresAt).toBe("2026-10-10T08:00:00.000Z");
    expect((await listTryOnPhotos(db, storage, customer, now)).map((p) => p.id)).toEqual([view.id]);
  });

  it("rejects landscape, dark and non-image uploads", async () => {
    const customer = await createUser();
    await expectTryOnError(uploadTryOnPhoto(db, storage, customer, { bytes: await photo(140, 900, 600), consent: "yes" }), "UPLOAD_INVALID");
    await expectTryOnError(uploadTryOnPhoto(db, storage, customer, { bytes: await photo(20), consent: "yes" }), "UPLOAD_INVALID");
    await expectTryOnError(uploadTryOnPhoto(db, storage, customer, { bytes: Buffer.from("<svg/>"), consent: "yes" }), "UPLOAD_INVALID");
    expect(await db.tryOnPhoto.count()).toBe(0);
  });

  it("admins can't upload try-on photos", async () => {
    const admin = await createUser("ADMIN");
    await expect(uploadTryOnPhoto(db, storage, admin, { bytes: await photo(), consent: "yes" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("try-on jobs", () => {
  it("tries a design on: checks the photo once, stores the result privately", async () => {
    const customer = await createUser();
    const { spec } = await customizableProduct();
    const pic = await uploaded(customer);
    const queued = await tryOnDesign(customer, pic.id, spec);
    expect(queued.cached).toBe(false);
    expect(await getTryOnStatus(db, storage, customer, queued.jobId)).toEqual({ state: "pending", position: "queued" });

    expect(await processNextJob(deps())).toBe(true);
    const status = await getTryOnStatus(db, storage, customer, queued.jobId);
    if (status.state !== "done") throw new Error(`expected done, got ${status.state}`);
    expect(status.result).toMatchObject({ photoId: pic.id, saved: false, garmentHash: designSignature(spec) });
    expect(status.result.imageUrl).toMatch(/^memory:\/\/tryon-private\//);
    expect(status.result.photoUrl).toMatch(/^memory:\/\/tryon-private\//);
    const result = await db.tryOnResult.findUniqueOrThrow({ where: { id: status.result.id } });
    expect(result.resultKey.startsWith(`${customer.id}/results/`)).toBe(true);
    expect((await db.tryOnPhoto.findUniqueOrThrow({ where: { id: pic.id } })).checkedAt).not.toBeNull();
    expect(await getTryOnQuota(db, customer)).toEqual({ used: 1, limit: 5, remaining: 4 });
  });

  it("tries a ready-made dress on", async () => {
    const customer = await createUser();
    const { product } = await customizableProduct();
    const pic = await uploaded(customer);
    const queued = await createTryOnJob(db, storage, customer, { photoId: pic.id, source: { kind: "product", productId: product.id } });
    await processNextJob(deps());
    expect((await getTryOnStatus(db, storage, customer, queued.jobId)).state).toBe("done");
    expect((await db.tryOnResult.findFirstOrThrow()).productId).toBe(product.id);
  });

  it("the same photo and design give the cached result; a changed design needs a new try-on", async () => {
    const customer = await createUser();
    const { spec } = await customizableProduct();
    const pic = await uploaded(customer);
    const first = await tryOnDesign(customer, pic.id, spec);
    expect(await tryOnDesign(customer, pic.id, spec)).toEqual({ jobId: first.jobId, cached: true });
    await processNextJob(deps());
    // A different size doesn't change what the preview shows.
    expect(await tryOnDesign(customer, pic.id, { ...spec, size: "M" })).toEqual({ jobId: first.jobId, cached: true });
    const changed = await tryOnDesign(customer, pic.id, { ...spec, parts: { skirt: { color: "#1b1b1b" } } });
    expect(changed.cached).toBe(false);
    expect((await getTryOnQuota(db, customer)).used).toBe(2);
  });

  it("allows 5 try-ons per Dhaka day", async () => {
    const customer = await createUser();
    const { spec } = await customizableProduct();
    const pic = await uploaded(customer);
    const colors = TEMPLATE.allowedColors.map((c) => c.hex.toLowerCase());
    for (let i = 0; i < 5; i++) {
      await tryOnDesign(customer, pic.id, { ...spec, parts: { skirt: { color: colors[i] ?? "#1b1b1b" } } });
    }
    await expect(tryOnDesign(customer, pic.id, { ...spec, parts: { skirt: { color: colors[6] ?? "#1b1b1b" } } })).rejects.toThrow(TRYON_QUOTA_MESSAGE);
  });

  it("a photo that fails the check gets a friendly message and uses no try-on", async () => {
    const customer = await createUser();
    const { spec } = await customizableProduct();
    const dim = await uploaded(customer, 50);
    const queued = await tryOnDesign(customer, dim.id, spec);
    await runAiJobs(deps());
    expect(await getTryOnStatus(db, storage, customer, queued.jobId)).toEqual({ state: "failed", message: AI_FAILURE_MESSAGES.PHOTO_REJECTED, code: "PHOTO_REJECTED" });
    expect(await db.aIJob.findUniqueOrThrow({ where: { id: queued.jobId } })).toMatchObject({ status: "FAILED", attempts: 1 });
    expect((await getTryOnQuota(db, customer)).used).toBe(0);
  });

  it("retries a hung provider after the timeout, and fails at once when the free GPU quota is used up", async () => {
    const customer = await createUser();
    const { spec } = await customizableProduct();
    const pic = await uploaded(customer);
    let calls = 0;
    const flaky: TryOnProvider = {
      name: "flaky",
      tryOn: (request, signal) => {
        calls++;
        return calls === 1
          ? new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))))
          : new FakeTryOn().tryOn(request, signal);
      },
    };
    const queued = await tryOnDesign(customer, pic.id, spec);
    await processNextJob(deps({ tryOn: flaky }, { timeoutsMs: { TRY_ON: 3000 } }));
    expect(await db.aIJob.findUniqueOrThrow({ where: { id: queued.jobId } })).toMatchObject({ status: "QUEUED", errorCode: "TIMEOUT" });
    await processNextJob(deps({ tryOn: flaky }));
    expect((await getTryOnStatus(db, storage, customer, queued.jobId)).state).toBe("done");

    const limited: TryOnProvider = {
      name: "limited",
      tryOn: async () => {
        throw new AiProviderError("every try-on space is over its free GPU quota", false, "TRYON_LIMIT");
      },
    };
    const second = await tryOnDesign(customer, pic.id, { ...spec, parts: { skirt: { color: "#1b1b1b" } } });
    await runAiJobs(deps({ tryOn: limited }));
    expect(await getTryOnStatus(db, storage, customer, second.jobId)).toMatchObject({ state: "failed", code: "TRYON_LIMIT", message: AI_FAILURE_MESSAGES.TRYON_LIMIT });
    expect(await db.aIJob.findUniqueOrThrow({ where: { id: second.jobId } })).toMatchObject({ attempts: 1 });
  });

  it("fails cleanly when the photo is deleted while the try-on waits", async () => {
    const customer = await createUser();
    const { spec } = await customizableProduct();
    const pic = await uploaded(customer);
    const queued = await tryOnDesign(customer, pic.id, spec);
    await deleteTryOnPhoto(db, storage, customer, pic.id);
    await runAiJobs(deps());
    expect(await getTryOnStatus(db, storage, customer, queued.jobId)).toMatchObject({ state: "failed", code: "NOT_AVAILABLE" });
  });

  it("customers can only use, poll and save their own photos and results", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const { spec } = await customizableProduct();
    const pic = await uploaded(alice);
    const queued = await tryOnDesign(alice, pic.id, spec);
    await processNextJob(deps());
    const status = await getTryOnStatus(db, storage, alice, queued.jobId);
    if (status.state !== "done") throw new Error("not done");

    await expectTryOnError(tryOnDesign(bob, pic.id, spec), "NOT_FOUND");
    await expectTryOnError(getTryOnStatus(db, storage, bob, queued.jobId), "NOT_FOUND");
    await expectTryOnError(setTryOnResultSaved(db, bob, status.result.id, true), "NOT_FOUND");
    await expectTryOnError(setTryOnPhotoSaved(db, bob, pic.id, true), "NOT_FOUND");
    await expectTryOnError(deleteTryOnPhoto(db, storage, bob, pic.id), "NOT_FOUND");
    expect(await listTryOnPhotos(db, storage, bob)).toEqual([]);
  });
});

describe("deleting and the 24-hour cleanup", () => {
  it("deleting a photo removes it and its try-ons at once, with an audit entry", async () => {
    const customer = await createUser();
    const { spec } = await customizableProduct();
    const pic = await uploaded(customer);
    await tryOnDesign(customer, pic.id, spec);
    await processNextJob(deps());
    const result = await db.tryOnResult.findFirstOrThrow();
    const photoRow = await db.tryOnPhoto.findUniqueOrThrow({ where: { id: pic.id } });

    await deleteTryOnPhoto(db, storage, customer, pic.id);
    expect(storage.has(BUCKETS.tryonPrivate, photoRow.storageKey)).toBe(false);
    expect(storage.has(BUCKETS.tryonPrivate, result.resultKey)).toBe(false);
    expect((await db.tryOnResult.findUniqueOrThrow({ where: { id: result.id } })).deletedAt).not.toBeNull();
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "tryon.photo_deleted" } })).toMatchObject({ actorId: customer.id, targetId: pic.id, metadata: { results: 1 } });
    expect(await listTryOnPhotos(db, storage, customer)).toEqual([]);
  });

  it("deletes only unsaved items older than 24 hours, idempotently, with one audit entry per run", async () => {
    const customer = await createUser();
    const { spec } = await customizableProduct();
    const old = await uploaded(customer);
    const kept = await uploaded(customer, 150);
    await tryOnDesign(customer, old.id, spec);
    await processNextJob(deps());
    const oldResult = await db.tryOnResult.findFirstOrThrow();
    const savedResultPhoto = await uploaded(customer, 160);
    await tryOnDesign(customer, savedResultPhoto.id, spec);
    await processNextJob(deps());
    const savedResult = await db.tryOnResult.findFirstOrThrow({ where: { photoId: savedResultPhoto.id } });
    await setTryOnResultSaved(db, customer, savedResult.id, true);
    await setTryOnPhotoSaved(db, customer, kept.id, true);
    const recent = await uploaded(customer, 170);

    const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await db.tryOnPhoto.updateMany({ where: { id: { in: [old.id, kept.id, savedResultPhoto.id] } }, data: { createdAt: longAgo } });
    await db.tryOnResult.updateMany({ data: { createdAt: longAgo } });
    const oldKey = (await db.tryOnPhoto.findUniqueOrThrow({ where: { id: old.id } })).storageKey;

    // old photo + its result + savedResultPhoto (unsaved photo) = 3 deleted; saved photo, saved result and recent kept.
    expect(await cleanupTryOnMedia(db, storage)).toBe(3);
    expect(storage.has(BUCKETS.tryonPrivate, oldKey)).toBe(false);
    expect(storage.has(BUCKETS.tryonPrivate, oldResult.resultKey)).toBe(false);
    expect(storage.has(BUCKETS.tryonPrivate, savedResult.resultKey)).toBe(true);
    const remaining = await db.tryOnPhoto.findMany({ where: { deletedAt: null }, select: { id: true } });
    expect(remaining.map((p) => p.id).sort()).toEqual([kept.id, recent.id].sort());
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "tryon.cleanup" } })).toMatchObject({ actorId: null, metadata: { photos: 2, results: 1 } });

    expect(await cleanupTryOnMedia(db, storage)).toBe(0);
    expect(await db.auditLog.count({ where: { action: "tryon.cleanup" } })).toBe(1);
  });
});
