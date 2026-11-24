import { ChevronRight, Palette, Scissors, ShieldCheck, Truck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/auth/session";
import { signCatalogImages } from "@/lib/catalog/images";
import { AUDIENCES, GARMENT_TYPES } from "@/lib/catalog/garment-types";
import { SIZE_ORDER, sizeChartFor } from "@/lib/catalog/size-chart";
import { getPrisma } from "@/lib/db";
import { DISPUTE_WINDOW_DAYS } from "@/lib/disputes/rules";
import { formatBDT } from "@/lib/money";
import { DELIVERY_FEES_MINOR, DELIVERY_ZONE_LABEL, DELIVERY_ZONES } from "@/lib/orders/delivery";
import { getProductBySlug } from "@/lib/shop/catalog";
import { productTryOnImageKey } from "@/lib/tryon/garment";

import { PurchasePanel } from "./purchase-panel";
import { TryOnButton } from "@/app/(shop)/_try-on/try-on-button";

export async function generateMetadata({ params }: PageProps<"/products/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProductBySlug(getPrisma(), slug);
  return { title: product ? `${product.name} — ClothSeeker` : "Not found — ClothSeeker" };
}

export default async function ProductPage({ params }: PageProps<"/products/[slug]">) {
  const { slug } = await params;
  const product = await getProductBySlug(getPrisma(), slug);
  if (!product) {
    notFound();
  }

  const sizes = SIZE_ORDER.filter((s) => product.variants.some((v) => v.size === s));
  const colors = [...new Map(product.variants.map((v) => [v.colorName, { name: v.colorName, hex: v.colorHex }])).values()];
  const chart = sizeChartFor(product.garmentType);
  const chartRows = chart.rows.filter((row) => sizes.includes(row.size));
  const garment = GARMENT_TYPES[product.garmentType];
  const [signed, user, tryOnImage] = await Promise.all([signCatalogImages(product.imageKeys), getCurrentUser(), productTryOnImageKey(getPrisma(), product.id)]);
  // The live mirror cuts the garment out of the same picture the try-on uses (signed for this viewer).
  const mirrorImageUrl = tryOnImage ? (signed.get(tryOnImage) ?? (await signCatalogImages([tryOnImage])).get(tryOnImage) ?? null) : null;
  const photos = product.imageKeys.flatMap((key) => {
    const url = signed.get(key);
    return url ? [url] : [];
  });

  const fees = DELIVERY_ZONES.map((zone) => `${DELIVERY_ZONE_LABEL[zone].toLowerCase()} ${formatBDT(DELIVERY_FEES_MINOR[zone])}`).join(", ");

  return (
    <div className="flex flex-col gap-12">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href={`/products?for=${garment.audience}`} className="hover:text-foreground">
          {AUDIENCES[garment.audience].label}
        </Link>
        <ChevronRight className="size-3.5" aria-hidden />
        <Link href={`/products?category=${product.category.slug}`} className="hover:text-foreground">
          {product.category.name}
        </Link>
      </nav>

      <PurchasePanel
        productId={product.id}
        slug={product.slug}
        name={product.name}
        garmentType={product.garmentType}
        variants={product.variants}
        sizes={sizes}
        colors={colors}
        photos={photos}
        eyebrow={
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs tracking-wide text-muted-foreground uppercase">{product.category.name}</span>
            {product.customizable && (
              <Badge variant="brand" className="gap-1">
                <Palette aria-hidden />
                Customizable
              </Badge>
            )}
          </div>
        }
      >
        {(product.customizable || tryOnImage) && (
          <div className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
            <p className="text-sm font-medium">{product.customizable ? "Make it yours, or see it on you first" : "See it on you first"}</p>
            <div className="flex flex-wrap gap-2">
              {product.customizable && (
                <Link href={`/customize/${product.id}`} className={buttonVariants({ variant: "default" })}>
                  <Palette aria-hidden />
                  Customize this {garment.noun}
                </Link>
              )}
              {tryOnImage && (
                <TryOnButton
                  productId={product.id}
                  slug={product.slug}
                  signedIn={user?.role === "CUSTOMER"}
                  noun={garment.noun}
                  garment={{ type: product.garmentType, sizes, productLengthCm: product.lengthCm }}
                  mirrorImageUrl={mirrorImageUrl}
                />
              )}
            </div>
          </div>
        )}
        <ul className="flex flex-col gap-2.5 text-sm text-muted-foreground">
          <li className="flex items-start gap-2.5">
            <Scissors className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
            Designed, made and checked by ClothSeeker&apos;s own tailors.
          </li>
          <li className="flex items-start gap-2.5">
            <Truck className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
            Delivery: {fees}.
          </li>
          <li className="flex items-start gap-2.5">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
            Something wrong when it arrives? Tell us within {DISPUTE_WINDOW_DAYS} days.
          </li>
        </ul>
      </PurchasePanel>

      <section className="grid gap-6 md:grid-cols-2 lg:gap-12">
        <div className="flex flex-col gap-3">
          <h2 className="text-2xl font-semibold">About this {garment.noun}</h2>
          <p className="leading-relaxed text-muted-foreground">{product.description}</p>
        </div>

        <div id="size-chart" className="flex scroll-mt-8 flex-col gap-3 rounded-2xl border bg-card p-5">
          <h2 className="text-2xl font-semibold">Size chart (cm)</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 font-medium">Size</th>
                {chart.columns.map((column) => (
                  <th key={column} className="py-2 font-medium">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {chartRows.map((row) => (
                <tr key={row.size} className="border-b last:border-0">
                  <td className="py-2 font-medium">{row.size}</td>
                  {row.cm.map(([from, to], i) => (
                    <td key={chart.columns[i]} className="py-2 tabular-nums">{`${from}–${to}`}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-muted-foreground">Between sizes? Choose the larger size for a relaxed fit.</p>
        </div>
      </section>
    </div>
  );
}
