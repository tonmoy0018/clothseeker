import { describe, expect, it } from "vitest";

import { getProductBySlug, listProducts } from "@/lib/shop/catalog";

import { createProduct, db, resetDatabaseBeforeEach } from "./helpers";

resetDatabaseBeforeEach();

describe("listProducts", () => {
  it("shows only active products with at least one in-stock active variant", async () => {
    await createProduct({ slug: "visible", variants: [{ size: "M", color: "Sage", priceMinor: 100_000, stock: 1 }] });
    await createProduct({
      slug: "draft",
      status: "DRAFT",
      variants: [{ size: "M", color: "Sage", priceMinor: 100_000, stock: 1 }],
    });
    await createProduct({ slug: "sold-out", variants: [{ size: "M", color: "Sage", priceMinor: 100_000, stock: 0 }] });
    await createProduct({
      slug: "inactive",
      variants: [{ size: "M", color: "Sage", priceMinor: 100_000, stock: 4, isActive: false }],
    });

    const slugs = (await listProducts(db, {})).map((p) => p.slug);
    expect(slugs).toEqual(["visible"]);
  });

  it("filters by category, size, color and price, and prices from matching variants", async () => {
    await createProduct({
      slug: "wrap",
      category: "casual",
      variants: [
        { size: "S", color: "Sage", priceMinor: 300_000, stock: 2 },
        { size: "XL", color: "Sage", priceMinor: 320_000, stock: 2 },
        { size: "M", color: "Navy", priceMinor: 300_000, stock: 0 },
      ],
    });
    await createProduct({
      slug: "gown",
      category: "formal",
      variants: [{ size: "M", color: "Navy", priceMinor: 950_000, stock: 1 }],
    });

    expect((await listProducts(db, { category: "formal" })).map((p) => p.slug)).toEqual(["gown"]);
    expect((await listProducts(db, { color: "navy" })).map((p) => p.slug)).toEqual(["gown"]);
    expect((await listProducts(db, { maxPrice: 5000 })).map((p) => p.slug)).toEqual(["wrap"]);

    const xl = await listProducts(db, { size: "XL" });
    expect(xl.map((p) => p.slug)).toEqual(["wrap"]);
    expect(xl[0]?.fromPriceMinor).toBe(320_000);

    expect((await listProducts(db, { minPrice: 3100, maxPrice: 3300 }))[0]?.fromPriceMinor).toBe(320_000);
  });
});

describe("getProductBySlug", () => {
  it("returns active products only, with active variants and capped availability", async () => {
    await createProduct({
      slug: "shown",
      variants: [
        { size: "M", color: "Sage", priceMinor: 100_000, stock: 40 },
        { size: "L", color: "Sage", priceMinor: 100_000, stock: 0 },
        { size: "S", color: "Sage", priceMinor: 100_000, stock: 3, isActive: false },
      ],
    });
    await createProduct({
      slug: "hidden",
      status: "ARCHIVED",
      variants: [{ size: "M", color: "Sage", priceMinor: 100_000, stock: 1 }],
    });

    const product = await getProductBySlug(db, "shown");
    expect(product?.variants.map((v) => [v.size, v.available])).toEqual([
      ["M", 10],
      ["L", 0],
    ]);
    expect(await getProductBySlug(db, "hidden")).toBeNull();
    expect(await getProductBySlug(db, "../etc/passwd")).toBeNull();
  });
});
