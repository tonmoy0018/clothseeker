import type { Metadata } from "next";
import Link from "next/link";

import { ProductCard } from "@/components/shop/product-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signCatalogImages } from "@/lib/catalog/images";
import { getPrisma } from "@/lib/db";
import { getFilterOptions, listProducts, parseProductFilters } from "@/lib/shop/catalog";

export const metadata: Metadata = { title: "Dresses — ClothSeeker" };

const selectClass =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export default async function ProductsPage({ searchParams }: PageProps<"/products">) {
  const filters = parseProductFilters(await searchParams);
  const db = getPrisma();
  const [products, options] = await Promise.all([listProducts(db, filters), getFilterOptions(db)]);
  const covers = await signCatalogImages(products.map((p) => p.coverKey));
  const activeCategory = options.categories.find((c) => c.slug === filters.category);
  const hasFilters = Object.values(filters).some((v) => v !== undefined);

  return (
    <div className="flex flex-col gap-6 md:flex-row">
      <aside className="md:w-56 md:shrink-0">
        {/* Plain GET form: filters live in the URL and work without JavaScript. */}
        <form action="/products" method="get" className="flex flex-col gap-4" aria-label="Filter dresses">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="category">Category</Label>
            <select id="category" name="category" defaultValue={filters.category ?? ""} className={selectClass}>
              <option value="">All categories</option>
              {options.categories.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="size">Size</Label>
            <select id="size" name="size" defaultValue={filters.size ?? ""} className={selectClass}>
              <option value="">Any size</option>
              {options.sizes.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="color">Color</Label>
            <select id="color" name="color" defaultValue={filters.color ?? ""} className={selectClass}>
              <option value="">Any color</option>
              {options.colors.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">Price (৳)</legend>
            <div className="flex items-center gap-2">
              <Input
                name="minPrice"
                type="number"
                min={0}
                step={100}
                placeholder="Min"
                aria-label="Minimum price in taka"
                defaultValue={filters.minPrice}
              />
              <span aria-hidden>–</span>
              <Input
                name="maxPrice"
                type="number"
                min={0}
                step={100}
                placeholder="Max"
                aria-label="Maximum price in taka"
                defaultValue={filters.maxPrice}
              />
            </div>
          </fieldset>
          <div className="flex gap-2">
            <Button type="submit" className="flex-1">
              Apply filters
            </Button>
            {hasFilters && (
              <Link href="/products" className="self-center text-sm text-muted-foreground hover:text-foreground">
                Clear
              </Link>
            )}
          </div>
        </form>
      </aside>

      <section className="flex flex-1 flex-col gap-4" aria-live="polite">
        <div className="flex items-baseline justify-between">
          <h1 className="text-2xl font-semibold">{activeCategory ? `${activeCategory.name} dresses` : "All dresses"}</h1>
          <span className="text-sm text-muted-foreground" data-testid="result-count">
            {products.length} {products.length === 1 ? "dress" : "dresses"}
          </span>
        </div>
        {products.length === 0 ? (
          <div className="flex flex-col items-start gap-2 rounded-xl border p-8">
            <p className="font-medium">No dresses match these filters.</p>
            <p className="text-sm text-muted-foreground">Try another size or color, or widen the price range.</p>
            <Link href="/products" className="text-sm underline">
              Clear all filters
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
            {products.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                imageUrl={product.coverKey ? covers.get(product.coverKey) : undefined}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
