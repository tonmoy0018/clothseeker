import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";

import { ForbiddenError } from "@/lib/auth/policy";
import { addDesignToCart, deleteDesign, DesignError, getDesignForEdit, listDesigns, saveDesign, uploadDesignImage } from "@/lib/design/service";
import { getCart } from "@/lib/shop/cart";
import { BUCKETS } from "@/lib/storage/buckets";
import type { MemoryStorageAdapter } from "@/lib/storage/memory";
import type { DesignSpec } from "@/types/design-spec";

import { storageWithTemplateAssets, TEMPLATE, validSpec } from "../fixtures/design";

import { createProduct, createUser, db, resetDatabaseBeforeEach } from "./helpers";

resetDatabaseBeforeEach();

let storage: MemoryStorageAdapter;
beforeEach(async () => {
  storage = await storageWithTemplateAssets();
});

async function customizableProduct() {
  const product = await createProduct({
    variants: [
      { size: "M", color: "Sage", priceMinor: 320_000, stock: 3 },
      { size: "M", color: "Navy", priceMinor: 300_000, stock: 3 },
      { size: "L", color: "Sage", priceMinor: 330_000, stock: 3 },
    ],
  });
  const template = await db.customizationTemplate.create({
    data: { productId: product.id, version: 7, config: TEMPLATE, isActive: true, aiEnabled: true },
  });
  return { product, template };
}

function specFor(product: { id: string }, template: { id: string }, overrides: Partial<DesignSpec> = {}): DesignSpec {
  return validSpec({ productId: product.id, templateId: template.id, templateVersion: 1, ...overrides });
}

async function expectDesignError(promise: Promise<unknown>, code: DesignError["code"]) {
  await expect(promise).rejects.toSatisfy((e) => e instanceof DesignError && e.code === code);
}

describe("saveDesign", () => {
  it("saves a valid design, stamps the current template version, prices it and stores a preview", async () => {
    const customer = await createUser();
    const { product, template } = await customizableProduct();

    const saved = await saveDesign(db, storage, customer, { spec: { ...specFor(product, template), priceMinor: 1 } });

    // Base = cheapest M (৳3,000) + square neckline 150 + midi 200 + pattern 200 + text 150 + decoration 100.
    expect(saved.price.totalMinor).toBe(380_000);
    const design = await db.design.findUniqueOrThrow({ where: { id: saved.designId } });
    expect(design).toMatchObject({ customerId: customer.id, templateVersion: 7, status: "SAVED" });
    expect(JSON.stringify(design.spec)).not.toContain("priceMinor");
    expect(saved.previewKey.startsWith(`${customer.id}/previews/`)).toBe(true);
    expect(storage.has(BUCKETS.designAssets, saved.previewKey)).toBe(true);
  });

  it("re-saving replaces the old preview", async () => {
    const customer = await createUser();
    const { product, template } = await customizableProduct();
    const first = await saveDesign(db, storage, customer, { spec: specFor(product, template) });
    const second = await saveDesign(db, storage, customer, { designId: first.designId, spec: specFor(product, template, { size: "L" }) });
    expect(second.designId).toBe(first.designId);
    expect(storage.has(BUCKETS.designAssets, first.previewKey)).toBe(false);
    expect(second.price.lines[0]).toEqual({ label: "Dress, size L", amountMinor: 330_000 });
  });

  it("rejects designs that break the template rules", async () => {
    const customer = await createUser();
    const { product, template } = await customizableProduct();
    await expectDesignError(saveDesign(db, storage, customer, { spec: specFor(product, template, { size: "XS" }) }), "INVALID");
    await expectDesignError(saveDesign(db, storage, customer, { spec: specFor(product, template, { parts: { skirt: { color: "#123456" } } }) }), "INVALID");
    await expectDesignError(saveDesign(db, storage, customer, { spec: { version: 1, nonsense: true } }), "INVALID");
    expect(await db.design.count()).toBe(0);
  });

  it("rejects products that aren't customizable right now", async () => {
    const customer = await createUser();
    const { product, template } = await customizableProduct();
    await db.product.update({ where: { id: product.id }, data: { status: "DRAFT" } });
    await expectDesignError(saveDesign(db, storage, customer, { spec: specFor(product, template) }), "NOT_CUSTOMIZABLE");
    await db.product.update({ where: { id: product.id }, data: { status: "ACTIVE" } });
    await db.customizationTemplate.update({ where: { id: template.id }, data: { isActive: false } });
    await expectDesignError(saveDesign(db, storage, customer, { spec: specFor(product, template) }), "NOT_CUSTOMIZABLE");
  });

  it("revalidates old designs against the current template", async () => {
    const customer = await createUser();
    const { product, template } = await customizableProduct();
    const saved = await saveDesign(db, storage, customer, { spec: specFor(product, template) });
    // The team removes the square neckline from the template.
    await db.customizationTemplate.update({
      where: { id: template.id },
      data: {
        version: 8,
        config: { ...TEMPLATE, styleOptions: { ...TEMPLATE.styleOptions, neckline: TEMPLATE.styleOptions.neckline.filter((o) => o.id !== "square") } },
      },
    });
    await expectDesignError(addDesignToCart(db, storage, customer, saved.designId), "INVALID");
    const listed = await listDesigns(db, storage, customer);
    expect(listed[0]?.check).toEqual({ price: null, issue: "Needs changes" });
  });

  it("customers can't edit, load or order another customer's design; admins can't design", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const admin = await createUser("ADMIN");
    const { product, template } = await customizableProduct();
    const saved = await saveDesign(db, storage, alice, { spec: specFor(product, template) });

    await expectDesignError(saveDesign(db, storage, bob, { designId: saved.designId, spec: specFor(product, template) }), "NOT_FOUND");
    await expectDesignError(addDesignToCart(db, storage, bob, saved.designId), "NOT_FOUND");
    expect(await getDesignForEdit(db, storage, bob, saved.designId, product.id)).toBeNull();
    expect(await listDesigns(db, storage, bob)).toHaveLength(0);
    await expect(saveDesign(db, storage, admin, { spec: specFor(product, template) })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("design images", () => {
  async function png() {
    return sharp({ create: { width: 400, height: 300, channels: 4, background: { r: 30, g: 60, b: 90, alpha: 0.5 } } }).png().toBuffer();
  }

  it("stores uploads under the customer's own prefix and lets only them use it", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const { product, template } = await customizableProduct();
    const upload = await uploadDesignImage(storage, alice, await png());
    expect(upload.key.startsWith(`${alice.id}/uploads/`)).toBe(true);

    const imageLayer = { id: "i1", areaId: "front-skirt", kind: "image" as const, x: 0.2, y: 0.2, w: 0.5, h: 0.5, rotation: 10, image: { assetKey: upload.key } };
    await saveDesign(db, storage, alice, { spec: specFor(product, template, { layers: [imageLayer] }) });
    await expectDesignError(saveDesign(db, storage, bob, { spec: specFor(product, template, { layers: [imageLayer] }) }), "INVALID");
  });

  it("rejects non-images", async () => {
    const alice = await createUser();
    await expectDesignError(uploadDesignImage(storage, alice, Buffer.from("<svg onload='x'/>")), "UPLOAD_INVALID");
  });
});

describe("cart with custom designs", () => {
  it("adds a design once, priced on the server, and the cart can be checked out", async () => {
    const customer = await createUser();
    const { product, template } = await customizableProduct();
    const saved = await saveDesign(db, storage, customer, { spec: specFor(product, template) });
    await addDesignToCart(db, storage, customer, saved.designId);
    await addDesignToCart(db, storage, customer, saved.designId);

    const cart = await getCart(db, storage, customer);
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]).toMatchObject({ kind: "CUSTOM_DESIGN", unitPriceMinor: 380_000, issue: null });
    expect(cart.hasCustomDesigns).toBe(true);
    expect(cart.canCheckout).toBe(true);
  });
});

describe("deleteDesign", () => {
  it("deletes only the owner's design, with its cart line and preview", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const { product, template } = await customizableProduct();
    const saved = await saveDesign(db, storage, alice, { spec: specFor(product, template) });
    await addDesignToCart(db, storage, alice, saved.designId);

    await expectDesignError(deleteDesign(db, storage, bob, saved.designId), "NOT_FOUND");
    await deleteDesign(db, storage, alice, saved.designId);
    expect(await db.design.count()).toBe(0);
    expect(await db.cartItem.count()).toBe(0);
    expect(storage.has(BUCKETS.designAssets, saved.previewKey)).toBe(false);
  });
});
