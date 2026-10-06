import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { AdminError } from "@/lib/admin/errors";
import {
  createTemplate,
  getTemplateForEdit,
  saveTemplate,
  setTemplateState,
  uploadTemplateImage,
} from "@/lib/admin/templates";
import { ForbiddenError } from "@/lib/auth/policy";
import { getCustomizationTemplate } from "@/lib/catalog/template-loader";
import { BUCKETS } from "@/lib/storage/buckets";
import { MemoryStorageAdapter } from "@/lib/storage/memory";

import { createProduct, createUser, db, resetDatabaseBeforeEach } from "./helpers";

resetDatabaseBeforeEach();

async function garment(): Promise<Uint8Array> {
  return sharp({ create: { width: 1200, height: 1560, channels: 3, background: "#ececec" } }).png().toBuffer();
}

async function setup() {
  const admin = await createUser("ADMIN");
  const product = await createProduct({ variants: [{ size: "M", color: "Sage", priceMinor: 100_000, stock: 2 }] });
  const storage = new MemoryStorageAdapter();
  await createTemplate(db, admin, product.id);
  return { admin, product, storage };
}

async function expectAdminError(promise: Promise<unknown>, code: AdminError["code"]) {
  await expect(promise).rejects.toSatisfy((e) => e instanceof AdminError && e.code === code);
}

describe("templates", () => {
  it("only admins can create, read, save or upload", async () => {
    const { product, storage } = await setup();
    const customer = await createUser();
    await expect(createTemplate(db, customer, product.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getTemplateForEdit(db, storage, customer, product.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      saveTemplate(db, storage, customer, { productId: product.id, expectedVersion: 1, config: {} }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      uploadTemplateImage(db, storage, customer, { productId: product.id, slot: "front" }, await garment()),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("saves with optimistic locking, bumps the version and audits", async () => {
    const { admin, product, storage } = await setup();
    const loaded = await getTemplateForEdit(db, storage, admin, product.id);
    if (!loaded) throw new Error("template missing");

    const next = { ...loaded.config, allowedFonts: ["inter"] };
    expect(await saveTemplate(db, storage, admin, { productId: product.id, expectedVersion: 1, config: next })).toEqual({
      version: 2,
    });
    await expectAdminError(
      saveTemplate(db, storage, admin, { productId: product.id, expectedVersion: 1, config: next }),
      "CONFLICT",
    );
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "template.update" } });
    expect(audit.metadata).toMatchObject({ fromVersion: 1, toVersion: 2 });
  });

  it("rejects image keys that belong to another product", async () => {
    const { admin, product, storage } = await setup();
    const loaded = await getTemplateForEdit(db, storage, admin, product.id);
    if (!loaded) throw new Error("template missing");
    const foreign = "11111111-1111-4111-8111-111111111111/template/22222222-2222-4222-8222-222222222222.webp";
    await expectAdminError(
      saveTemplate(db, storage, admin, {
        productId: product.id,
        expectedVersion: 1,
        config: { ...loaded.config, garmentImages: { front: foreign } },
      }),
      "INVALID",
    );
  });

  it("blocks activation until complete, deletes replaced images, and exposes only live templates", async () => {
    const { admin, product, storage } = await setup();
    await expectAdminError(setTemplateState(db, admin, { productId: product.id, isActive: true, aiEnabled: false }), "BLOCKED");

    const front = await uploadTemplateImage(db, storage, admin, { productId: product.id, slot: "front" }, await garment());
    const back = await uploadTemplateImage(db, storage, admin, { productId: product.id, slot: "back" }, await garment());
    expect(front.key.startsWith(`${product.id}/template/`)).toBe(true);
    const loaded = await getTemplateForEdit(db, storage, admin, product.id);
    if (!loaded) throw new Error("template missing");
    const withImages = { ...loaded.config, garmentImages: { front: front.key, back: back.key } };
    await saveTemplate(db, storage, admin, { productId: product.id, expectedVersion: 1, config: withImages });

    // Recolorable regions still have no masks: activation is refused.
    await expectAdminError(setTemplateState(db, admin, { productId: product.id, isActive: true, aiEnabled: true }), "BLOCKED");

    // Masks are stored as lossless grayscale PNG under the product's template prefix.
    const mask = await uploadTemplateImage(db, storage, admin, { productId: product.id, slot: "mask:front:bodice" }, await garment());
    expect(mask.key).toMatch(new RegExp(`^${product.id}/template/[0-9a-f-]+\\.png$`));
    const maskMeta = await sharp(await storage.get(BUCKETS.productMedia, mask.key) ?? Buffer.alloc(0)).metadata();
    expect([maskMeta.format, maskMeta.channels]).toEqual(["png", 1]);
    await saveTemplate(db, storage, admin, {
      productId: product.id,
      expectedVersion: 2,
      config: { ...withImages, regions: [{ id: "bodice", label: "Bodice", recolorable: true, masks: { front: mask.key } }] },
    });

    // Draft product + inactive template: invisible to customers.
    expect(await getCustomizationTemplate(db, storage, product.id)).toBeNull();
    await setTemplateState(db, admin, { productId: product.id, isActive: true, aiEnabled: true });
    expect(await getCustomizationTemplate(db, storage, product.id)).not.toBeNull(); // helper products are ACTIVE

    // Replacing the front image deletes the old object once saved.
    const newFront = await uploadTemplateImage(db, storage, admin, { productId: product.id, slot: "front" }, await garment());
    const current = await getTemplateForEdit(db, storage, admin, product.id);
    if (!current) throw new Error("template missing");
    await saveTemplate(db, storage, admin, {
      productId: product.id,
      expectedVersion: current.version,
      config: { ...current.config, garmentImages: { front: newFront.key, back: back.key } },
    });
    expect(storage.has(BUCKETS.productMedia, front.key)).toBe(false);
    expect(storage.has(BUCKETS.productMedia, newFront.key)).toBe(true);

    // A live template can't be saved into an incomplete state.
    await expectAdminError(
      saveTemplate(db, storage, admin, {
        productId: product.id,
        expectedVersion: current.version + 1,
        config: { ...current.config, garmentImages: {} },
      }),
      "BLOCKED",
    );

    const forCustomer = await getCustomizationTemplate(db, storage, product.id);
    expect(forCustomer?.imageUrls[newFront.key]).toMatch(/^memory:\/\//);
    expect(forCustomer?.aiEnabled).toBe(true);
  });

  it("hides templates of products that aren't live", async () => {
    const { admin, product, storage } = await setup();
    await db.customizationTemplate.update({ where: { productId: product.id }, data: { isActive: true } });
    await db.product.update({ where: { id: product.id }, data: { status: "DRAFT" } });
    expect(await getCustomizationTemplate(db, storage, product.id)).toBeNull();
    expect(await getCustomizationTemplate(db, storage, "not-a-uuid")).toBeNull();
    expect(admin.role).toBe("ADMIN");
  });

  it("upgrades v1 configs when loading", async () => {
    const { admin, product, storage } = await setup();
    await db.customizationTemplate.update({
      where: { productId: product.id },
      data: {
        config: {
          schemaVersion: 1,
          regions: [{ id: "bodice", label: "Bodice", recolorable: true }],
          placementAreas: [],
          styleOptions: {
            neckline: [{ id: "round", label: "Round", addOnPriceMinor: 0 }],
            sleeveLength: [{ id: "short", label: "Short", addOnPriceMinor: 0 }],
            dressLength: [{ id: "midi", label: "Midi", addOnPriceMinor: 0 }],
          },
          allowedColors: [{ name: "Black", hex: "#1b1b1b" }],
        },
      },
    });
    const loaded = await getTemplateForEdit(db, storage, admin, product.id);
    expect(loaded?.config.schemaVersion).toBe(3);
  });
});
