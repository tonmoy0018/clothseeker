import { ArrowRight, Camera, Palette, Ruler, Scissors, Sparkles, Truck } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

import { ProductCard } from "@/components/shop/product-card";
import { buttonVariants } from "@/components/ui/button";
import { AUDIENCE_IDS, AUDIENCES } from "@/lib/catalog/garment-types";
import { signCatalogImages } from "@/lib/catalog/images";
import { getPrisma } from "@/lib/db";
import { getFilterOptions, listProducts } from "@/lib/shop/catalog";

const STEPS = [
  { icon: Palette, title: "Choose or design", text: "Buy a piece as it is, or change its colours, patterns and details by hand." },
  { icon: Sparkles, title: "Ask for ideas", text: "Describe what you want, add photos, and pick from four designs each time." },
  { icon: Ruler, title: "See it on you", text: "Try it on your own photo or in the live mirror, and find the size that fits." },
  { icon: Truck, title: "We make it", text: "Our tailors make your piece, check it and deliver it to your door." },
];

export default async function HomePage() {
  const db = getPrisma();
  const [products, options] = await Promise.all([listProducts(db, {}, 24), getFilterOptions(db)]);
  const covers = await signCatalogImages(products.map((p) => p.coverKey));
  const cover = (key: string | null) => (key ? covers.get(key) : undefined);
  const featured = products.slice(0, 8);
  // The hero shows three pieces; each category tile the first piece filed under it.
  const heroPieces = products.flatMap((p) => (cover(p.coverKey) ? [{ name: p.name, url: cover(p.coverKey) ?? "" }] : [])).slice(0, 3);
  const categoryPicture = (name: string) => cover(products.find((p) => p.categoryName === name && cover(p.coverKey))?.coverKey ?? null);

  return (
    <div className="flex flex-col gap-16 sm:gap-20">
      <section className="grid items-center gap-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:gap-14">
        <div className="flex flex-col items-start gap-6">
          <p className="flex items-center gap-2 text-sm font-medium tracking-wide text-brand uppercase">
            <Scissors className="size-4" aria-hidden />
            Custom clothing, made for you
          </p>
          <h1 className="text-4xl leading-[1.1] font-semibold text-balance sm:text-5xl lg:text-[3.4rem]">
            Clothes you choose, customize and love — <span className="text-brand italic">made by ClothSeeker.</span>
          </h1>
          <p className="max-w-xl text-lg text-muted-foreground">
            Women&apos;s dresses and men&apos;s shirts and panjabis. Buy ready-made in your size and color, customize by hand or with AI, and see it on you before you order.
          </p>
          <div className="flex flex-wrap gap-3">
            {AUDIENCE_IDS.map((audience, i) => (
              <Link key={audience} href={`/products?for=${audience}`} className={buttonVariants({ size: "lg", variant: i === 0 ? "default" : "outline" })}>
                Shop {AUDIENCES[audience].label.toLowerCase()}
              </Link>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <Link href="/design/upload" className="flex items-center gap-1.5 font-medium underline decoration-brand decoration-2 underline-offset-4 hover:text-brand">
              <Camera className="size-4" aria-hidden />
              Upload your dress
            </Link>
            <Link href="/design/start" className="flex items-center gap-1.5 font-medium underline decoration-brand decoration-2 underline-offset-4 hover:text-brand">
              <Sparkles className="size-4" aria-hidden />
              Start from a photo or idea
            </Link>
          </div>
        </div>

        {heroPieces.length > 0 ? (
          <div className="relative mx-auto grid w-full max-w-md grid-cols-6 items-end gap-3 sm:max-w-lg lg:max-w-none" aria-hidden>
            <div className="absolute inset-x-6 top-10 bottom-0 -z-10 rounded-[2.5rem] bg-brand-soft" />
            {heroPieces.map((piece, i) => (
              <div
                key={piece.url}
                className={[
                  "relative overflow-hidden rounded-3xl bg-muted shadow-xl ring-1 ring-black/5",
                  i === 0 ? "col-span-4 col-start-1 row-span-2 aspect-[4/5]" : "col-span-2 aspect-[3/4]",
                  i === 1 ? "mt-6" : "",
                ].join(" ")}
              >
                <Image src={piece.url} alt="" fill unoptimized priority={i === 0} sizes="(min-width: 1024px) 30vw, 60vw" className="object-cover" />
              </div>
            ))}
          </div>
        ) : (
          <div className="hidden aspect-[5/4] rounded-[2.5rem] bg-brand-soft lg:block" aria-hidden />
        )}
      </section>

      <section aria-labelledby="how-heading" className="rounded-3xl border bg-card px-6 py-8 sm:px-10 sm:py-10">
        <h2 id="how-heading" className="text-2xl font-semibold">
          How it works
        </h2>
        <ol className="mt-6 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex flex-col gap-2">
              <span className="flex size-11 items-center justify-center rounded-full bg-brand-soft text-brand">
                <step.icon className="size-5" aria-hidden />
              </span>
              <span className="mt-1 font-medium">
                <span className="text-muted-foreground">{i + 1}.</span> {step.title}
              </span>
              <span className="text-sm text-muted-foreground">{step.text}</span>
            </li>
          ))}
        </ol>
      </section>

      {options.categories.length > 0 && (
        <section aria-labelledby="categories-heading" className="flex flex-col gap-6">
          <h2 id="categories-heading" className="text-2xl font-semibold">
            Shop by category
          </h2>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {options.categories.map((category) => {
              const picture = categoryPicture(category.name);
              return (
                <li key={category.slug}>
                  <Link
                    href={`/products?category=${category.slug}`}
                    className="group relative flex aspect-[4/5] items-end overflow-hidden rounded-2xl bg-secondary outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
                  >
                    {picture && <Image src={picture} alt="" fill unoptimized sizes="(min-width: 1024px) 20vw, 50vw" className="object-cover transition-transform duration-300 group-hover:scale-105" />}
                    <span className={picture ? "relative w-full bg-gradient-to-t from-black/65 to-transparent px-4 pt-10 pb-3 font-medium text-white" : "relative w-full px-4 pb-3 font-medium"}>
                      {category.name}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section aria-labelledby="featured-heading" className="flex flex-col gap-6">
        <div className="flex items-baseline justify-between">
          <h2 id="featured-heading" className="text-2xl font-semibold">
            New in
          </h2>
          <Link href="/products" className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground">
            View all
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>
        {featured.length > 0 ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
            {featured.map((product) => (
              <ProductCard key={product.id} product={product} imageUrl={cover(product.coverKey)} />
            ))}
          </div>
        ) : (
          <p className="rounded-2xl border border-dashed p-8 text-sm text-muted-foreground">New pieces are on their way.</p>
        )}
      </section>

      <section className="grid items-center gap-6 rounded-3xl bg-primary px-6 py-10 text-primary-foreground sm:px-10 lg:grid-cols-[1fr_auto]">
        <div className="flex flex-col gap-2">
          <h2 className="text-2xl font-semibold sm:text-3xl">Have a piece you love?</h2>
          <p className="max-w-2xl text-primary-foreground/75">Send us a photo. We&apos;ll make it for you exactly as it is, or let you change its colours and details first. Our tailors reply with a price within a day.</p>
        </div>
        <Link href="/design/upload" className={buttonVariants({ size: "lg", variant: "brand" })}>
          <Camera aria-hidden />
          Send a photo
        </Link>
      </section>
    </div>
  );
}
