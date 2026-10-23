import type { Metadata } from "next";
import Link from "next/link";

import { ProductCard } from "@/components/shop/product-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AUDIENCE_IDS, AUDIENCES } from "@/lib/catalog/garment-types";
import { signCatalogImages } from "@/lib/catalog/images";
import { getPrisma } from "@/lib/db";
import { getFilterOptions, listProducts, parseProductFilters } from "@/lib/shop/catalog";

export async function generateMetadata({ searchParams }: PageProps<"/products">): Promise<Metadata> {
  const section = parseProductFilters(await searchParams).for;
  return { title: `${section ? AUDIENCES[section].heading : "Shop"} — ClothSeeker` };
}

const selectClass =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export default async function ProductsPage({ searchParams }: PageProps<"/products">) {
  const filters = parseProductFilters(await searchParams);
  const db = getPrisma();
  const [products, options] = await Promise.all([listProducts(db, filters), getFilterOptions(db, filters.for)]);
  const covers = await signCatalogImages(products.map((p) => p.coverKey));
  const activeCategory = options.categories.find((c) => c.slug === filters.category);
  const { for: section, ...narrowing } = filters;
  const hasFilters = Object.values(narrowing).some((v) => v !== undefined);
  // "Casual dresses" in the women's section, "Casual" elsewhere; "All clothing" with no section.
  const sectionInfo = section ? AUDIENCES[section] : null;
  const heading = activeCategory ? `${activeCategory.name}${sectionInfo?.plural === "dresses" ? " dresses" : ""}` : (sectionInfo?.heading ?? "All clothing");
  const plural = sectionInfo?.plural ?? "items";
  const clearHref = section ? `/products?for=${section}` : "/products";

  return (
    <div className="flex flex-col gap-6 md:flex-row">
      <aside className="md:w-56 md:shrink-0">
        {/* Plain GET form: filters live in the URL and work without JavaScript. */}
        <form action="/products" method="get" className="flex flex-col gap-4" aria-label="Filter the shop">
          {section && <input type="hidden" name="for" value={section} />}
          <div className="flex rounded-lg border p-0.5 text-sm" role="group" aria-label="Shop section">
            {[{ href: "/products", label: "All", active: !section }, ...AUDIENCE_IDS.map((a) => ({ href: `/products?for=${a}`, label: AUDIENCES[a].label, active: section === a }))].map((tab) => (
              <Link key={tab.href} href={tab.href} aria-current={tab.active ? "page" : undefined} className={tab.active ? "flex-1 rounded-md bg-muted py-1 text-center font-medium" : "flex-1 rounded-md py-1 text-center text-muted-foreground hover:text-foreground"}>
                {tab.label}
              </Link>
            ))}
          </div>
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
              <Link href={clearHref} className="self-center text-sm text-muted-foreground hover:text-foreground">
                Clear
              </Link>
            )}
          </div>
        </form>
      </aside>

      <section className="flex flex-1 flex-col gap-4" aria-live="polite">
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3">
            <h1 className="text-2xl font-semibold">{heading}</h1>
            <span className="shrink-0 text-sm text-muted-foreground" data-testid="result-count">
              {products.length} {products.length === 1 ? plural.replace(/(es|s)$/, "") : plural}
            </span>
          </div>
          <Link href="/design/start" className="self-start text-sm underline underline-offset-4">
            Have something in mind? Start from a photo or description
          </Link>
        </div>
        {products.length === 0 ? (
          <div className="flex flex-col items-start gap-2 rounded-xl border p-8">
            <p className="font-medium">Nothing matches these filters.</p>
            <p className="text-sm text-muted-foreground">Try another size or color, or widen the price range.</p>
            <Link href={clearHref} className="text-sm underline">
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
