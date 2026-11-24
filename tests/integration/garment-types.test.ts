import { describe, expect, it } from "vitest";

import { AdminError } from "@/lib/admin/errors";
import { createProduct as adminCreateProduct, updateProduct } from "@/lib/admin/products";
import { createTemplate, getTemplateForEdit, saveTemplate } from "@/lib/admin/templates";
import { DEFAULT_TEMPLATE_CONFIG } from "@/lib/catalog/default-template";
import { getFilterOptions, getProductBySlug, listProducts, parseProductFilters } from "@/lib/shop/catalog";
import { MemoryStorageAdapter } from "@/lib/storage/memory";

import { createProduct, createUser, db, resetDatabaseBeforeEach } from "./helpers";

resetDatabaseBeforeEach();

const variant = { size: "M" as const, color: "Navy", priceMinor: 250_000, stock: 3 };

describe("shop sections", () => {
  it("shows women's dresses and men's shirts and panjabis in their own sections", async () => {
    const dress = await createProduct({ variants: [variant] });
    const shirt = await createProduct({ garmentType: "shirt", category: "formal", variants: [variant] });
    const panjabi = await createProduct({ garmentType: "panjabi", category: "traditional", variants: [variant] });

    const ids = async (query: Record<string, string>) => (await listProducts(db, parseProductFilters(query))).map((p) => p.id).sort();
    expect(await ids({ for: "women" })).toEqual([dress.id]);
    expect(await ids({ for: "men" })).toEqual([shirt.id, panjabi.id].sort());
    expect(await ids({})).toEqual([dress.id, shirt.id, panjabi.id].sort());
    // An unknown section is ignored, not an error.
    expect(await ids({ for: "kids" })).toHaveLength(3);

    // Each section only offers its own categories.
    expect((await getFilterOptions(db, "men")).categories.map((c) => c.slug).sort()).toEqual(["formal", "traditional"]);
    expect((await getProductBySlug(db, shirt.slug))?.garmentType).toBe("shirt");
  });
});

describe("garment types in the team tool", () => {
  async function setup() {
    const admin = await createUser("ADMIN");
    const category = await db.category.create({ data: { slug: "formal", name: "Formal" } });
    const { id } = await adminCreateProduct(db, admin, { name: "Oxford Shirt", garmentType: "shirt", categoryId: category.id, description: "A crisp cotton Oxford shirt." });
    return { admin, category, id };
  }

  it("a new shirt's template starts with collar, sleeves and fit", async () => {
    const { admin, id } = await setup();
    await createTemplate(db, admin, id);
    const template = await getTemplateForEdit(db, new MemoryStorageAdapter(), admin, id);
    expect(template?.config.garmentType).toBe("shirt");
    expect(Object.keys(template?.config.styleOptions ?? {}).sort()).toEqual(["collar", "fit", "sleeveLength"]);
  });

  it("the garment type is fixed once a template exists, and templates must match it", async () => {
    const { admin, category, id } = await setup();
    const details = { id, slug: "oxford-shirt", name: "Oxford Shirt", categoryId: category.id, description: "A crisp cotton Oxford shirt." };
    // Before a template: changing it is fine.
    await updateProduct(db, admin, { ...details, garmentType: "panjabi" });
    await updateProduct(db, admin, { ...details, garmentType: "shirt" });

    await createTemplate(db, admin, id);
    await expect(updateProduct(db, admin, { ...details, garmentType: "dress" })).rejects.toSatisfy((e) => e instanceof AdminError && e.code === "BLOCKED");
    expect((await db.product.findUniqueOrThrow({ where: { id } })).garmentType).toBe("shirt");

    const template = await getTemplateForEdit(db, new MemoryStorageAdapter(), admin, id);
    if (!template) throw new Error("no template");
    await expect(saveTemplate(db, new MemoryStorageAdapter(), admin, { productId: id, expectedVersion: template.version, config: DEFAULT_TEMPLATE_CONFIG })).rejects.toSatisfy(
      (e) => e instanceof AdminError && e.code === "INVALID",
    );
  });
});
