import Link from "next/link";

import { ProductCard } from "@/components/shop/product-card";
import { buttonVariants } from "@/components/ui/button";
import { getPrisma } from "@/lib/db";
import { getFilterOptions, listProducts } from "@/lib/shop/catalog";

export default async function HomePage() {
  const db = getPrisma();
  const [featured, options] = await Promise.all([listProducts(db, {}, 8), getFilterOptions(db)]);

  return (
    <div className="flex flex-col gap-12">
      <section className="flex flex-col items-start gap-4 rounded-2xl bg-muted px-6 py-12 sm:px-10">
        <p className="text-sm font-medium text-muted-foreground">ClothSeeker</p>
        <h1 className="max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
          Dresses you choose, customize and love — made by ClothSeeker.
        </h1>
        <p className="max-w-xl text-muted-foreground">
          Buy ready-made in your size and color today. Custom designs, AI-assisted design and virtual try-on are coming
          soon.
        </p>
        <Link href="/products" className={buttonVariants({ size: "lg" })}>
          Shop all dresses
        </Link>
      </section>

      <section aria-labelledby="categories-heading" className="flex flex-col gap-4">
        <h2 id="categories-heading" className="text-xl font-semibold">
          Shop by category
        </h2>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {options.categories.map((category) => (
            <li key={category.slug}>
              <Link
                href={`/products?category=${category.slug}`}
                className="flex h-20 items-center justify-center rounded-xl border text-sm font-medium hover:bg-muted"
              >
                {category.name}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="featured-heading" className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between">
          <h2 id="featured-heading" className="text-xl font-semibold">
            New in
          </h2>
          <Link href="/products" className="text-sm text-muted-foreground hover:text-foreground">
            View all
          </Link>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {featured.map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      </section>
    </div>
  );
}
