import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { AdminError } from "@/lib/admin/errors";
import { removeProductPhoto, setCoverPhoto, uploadProductPhoto } from "@/lib/admin/media";
import { createProduct, getAdminProduct, listAdminProducts, setProductStatus, updateProduct } from "@/lib/admin/products";
import { addVariant, updateVariant } from "@/lib/admin/variants";
import { ForbiddenError } from "@/lib/auth/policy";
import { getProductBySlug, listProducts } from "@/lib/shop/catalog";
import { BUCKETS } from "@/lib/storage/buckets";
import { MemoryStorageAdapter } from "@/lib/storage/memory";

import { createUser, db, resetDatabaseBeforeEach } from "./helpers";

resetDatabaseBeforeEach();

async function category() {
  return db.category.upsert({ where: { slug: "casual" }, create: { slug: "casual", name: "Casual" }, update: {} });
}

async function photo(): Promise<Uint8Array> {
  return sharp({ create: { width: 900, height: 1100, channels: 3, background: "#c8664b" } }).jpeg().toBuffer();
}

async function adminWithDraft() {
  const admin = await createUser("ADMIN");
  const cat = await category();
  const { id } = await createProduct(db, admin, {
    name: "Test Wrap Dress",
    categoryId: cat.id,
    description: "A dress used in integration tests.",
  });
  return { admin, productId: id, categoryId: cat.id };
}

async function expectAdminError(promise: Promise<unknown>, code: AdminError["code"]) {
  await expect(promise).rejects.toSatisfy((e) => e instanceof AdminError && e.code === code);
}

describe("admin authorization", () => {
  it("refuses customers on every admin service", async () => {
    const { productId, categoryId } = await adminWithDraft();
    const customer = await createUser();
    const storage = new MemoryStorageAdapter();
    const bytes = await photo();
    const calls: (() => Promise<unknown>)[] = [
      () => createProduct(db, customer, { name: "Hack", categoryId, description: "Should never be created." }),
      () => updateProduct(db, customer, { id: productId, name: "X", slug: "xyz", categoryId, description: "Nope nope nope" }),
      () => setProductStatus(db, customer, { id: productId, status: "ACTIVE" }),
      () => listAdminProducts(db, customer, {}),
      () => getAdminProduct(db, customer, productId),
      () => addVariant(db, customer, { productId, size: "M", colorName: "Sage", colorHex: "#9caf88", priceTaka: 100, stock: 1 }),
      () => uploadProductPhoto(db, storage, customer, productId, bytes),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(storage.objects.size).toBe(0);
    expect(await db.product.count()).toBe(1);
  });
});

describe("products", () => {
  it("creates drafts with a generated slug and an audit entry", async () => {
    const { admin, productId } = await adminWithDraft();
    const product = await db.product.findUniqueOrThrow({ where: { id: productId } });
    expect(product).toMatchObject({ slug: "test-wrap-dress", status: "DRAFT" });
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "product.create" } });
    expect(audit).toMatchObject({ actorId: admin.id, targetType: "product", targetId: productId });
  });

  it("rejects duplicate slugs", async () => {
    const { admin, categoryId } = await adminWithDraft();
    await expectAdminError(
      createProduct(db, admin, { name: "Test Wrap Dress", categoryId, description: "Same name, same slug." }),
      "CONFLICT",
    );
  });

  it("records only changed field names on update", async () => {
    const { admin, productId, categoryId } = await adminWithDraft();
    await updateProduct(db, admin, {
      id: productId,
      name: "Renamed Dress",
      slug: "test-wrap-dress",
      categoryId,
      description: "A dress used in integration tests.",
    });
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "product.update" } });
    expect(audit.metadata).toEqual({ fields: ["name"] });
  });

  it("blocks publishing without a sellable variant, then publishes", async () => {
    const { admin, productId } = await adminWithDraft();
    await expectAdminError(setProductStatus(db, admin, { id: productId, status: "ACTIVE" }), "BLOCKED");

    await addVariant(db, admin, { productId, size: "M", colorName: "sage", colorHex: "#9CAF88", priceTaka: "3200.50", stock: "4" });
    await setProductStatus(db, admin, { id: productId, status: "ACTIVE" });

    const shop = await getProductBySlug(db, "test-wrap-dress");
    expect(shop?.variants).toEqual([{ size: "M", colorName: "Sage", colorHex: "#9caf88", priceMinor: 320_050, available: 4 }]);
  });

  it("keeps drafts, archived products and inactive variants out of the shop", async () => {
    const { admin, productId } = await adminWithDraft();
    const { id: variantId } = await addVariant(db, admin, {
      productId,
      size: "S",
      colorName: "Navy",
      colorHex: "#1f2a44",
      priceTaka: 2000,
      stock: 3,
    });
    expect(await listProducts(db, {})).toHaveLength(0);

    await setProductStatus(db, admin, { id: productId, status: "ACTIVE" });
    expect(await listProducts(db, {})).toHaveLength(1);

    await updateVariant(db, admin, { variantId, priceTaka: 2000, stock: 3, isActive: false });
    expect(await listProducts(db, {})).toHaveLength(0);

    await updateVariant(db, admin, { variantId, priceTaka: 2000, stock: 3, isActive: true });
    await setProductStatus(db, admin, { id: productId, status: "ARCHIVED" });
    expect(await getProductBySlug(db, "test-wrap-dress")).toBeNull();
  });
});

describe("variants", () => {
  it("rejects duplicate size+color and invalid prices", async () => {
    const { admin, productId } = await adminWithDraft();
    const base = { productId, size: "M", colorName: "Sage", colorHex: "#9caf88", priceTaka: 100, stock: 1 };
    await addVariant(db, admin, base);
    await expectAdminError(addVariant(db, admin, { ...base, colorName: "SAGE" }), "CONFLICT");
    await expect(addVariant(db, admin, { ...base, size: "L", priceTaka: 0 })).rejects.toBeInstanceOf(ZodError);
    await expect(addVariant(db, admin, { ...base, size: "L", priceTaka: 10.555 })).rejects.toBeInstanceOf(ZodError);
    await expect(addVariant(db, admin, { ...base, size: "L", colorHex: "javascript:1" })).rejects.toBeInstanceOf(ZodError);
  });
});

describe("photos", () => {
  it("stores a WebP under the product prefix, sets the cover, and deletes on removal", async () => {
    const { admin, productId } = await adminWithDraft();
    const storage = new MemoryStorageAdapter();

    const first = await uploadProductPhoto(db, storage, admin, productId, await photo());
    const second = await uploadProductPhoto(db, storage, admin, productId, await photo());
    expect(first.key).toMatch(new RegExp(`^${productId}/photos/[0-9a-f-]+\\.webp$`));
    expect(storage.objects.get(`${BUCKETS.productMedia}/${first.key}`)?.contentType).toBe("image/webp");

    await setCoverPhoto(db, admin, { productId, key: second.key });
    expect((await db.product.findUniqueOrThrow({ where: { id: productId } })).imageKeys).toEqual([second.key, first.key]);

    await removeProductPhoto(db, storage, admin, { productId, key: first.key });
    expect(storage.has(BUCKETS.productMedia, first.key)).toBe(false);
    expect((await db.product.findUniqueOrThrow({ where: { id: productId } })).imageKeys).toEqual([second.key]);
  });

  it("refuses invalid images without storing anything", async () => {
    const { admin, productId } = await adminWithDraft();
    const storage = new MemoryStorageAdapter();
    await expectAdminError(uploadProductPhoto(db, storage, admin, productId, Buffer.from("<svg/>")), "INVALID");
    expect(storage.objects.size).toBe(0);
  });

  it("only removes keys that belong to the product", async () => {
    const { admin, productId } = await adminWithDraft();
    const storage = new MemoryStorageAdapter();
    await expectAdminError(
      removeProductPhoto(db, storage, admin, { productId, key: "11111111-1111-4111-8111-111111111111/photos/x.webp" }),
      "NOT_FOUND",
    );
  });
});
