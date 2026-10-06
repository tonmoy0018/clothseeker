import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { signCatalogImages } from "@/lib/catalog/images";
import { SIZE_CHART, SIZE_ORDER } from "@/lib/catalog/size-chart";
import { getPrisma } from "@/lib/db";
import { getProductBySlug } from "@/lib/shop/catalog";

import { PurchasePanel } from "./purchase-panel";

export async function generateMetadata({ params }: PageProps<"/products/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProductBySlug(getPrisma(), slug);
  return { title: product ? `${product.name} — ClothSeeker` : "Dress not found — ClothSeeker" };
}

export default async function ProductPage({ params }: PageProps<"/products/[slug]">) {
  const { slug } = await params;
  const product = await getProductBySlug(getPrisma(), slug);
  if (!product) {
    notFound();
  }

  const sizes = SIZE_ORDER.filter((s) => product.variants.some((v) => v.size === s));
  const colors = [...new Map(product.variants.map((v) => [v.colorName, { name: v.colorName, hex: v.colorHex }])).values()];
  const chartRows = SIZE_CHART.filter((row) => sizes.includes(row.size));
  const signed = await signCatalogImages(product.imageKeys);
  const photos = product.imageKeys.flatMap((key) => {
    const url = signed.get(key);
    return url ? [url] : [];
  });

  return (
    <div className="flex flex-col gap-10">
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        <Link href="/products" className="hover:text-foreground">
          Dresses
        </Link>{" "}
        /{" "}
        <Link href={`/products?category=${product.category.slug}`} className="hover:text-foreground">
          {product.category.name}
        </Link>
      </nav>

      <PurchasePanel
        productId={product.id}
        slug={product.slug}
        name={product.name}
        variants={product.variants}
        sizes={sizes}
        colors={colors}
        photos={photos}
      />

      <section className="grid gap-8 md:grid-cols-2">
        <div className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">About this dress</h2>
          <p className="text-muted-foreground">{product.description}</p>
          <div className="flex flex-wrap gap-2 pt-2">
            {product.customizable && <Badge variant="secondary">Customizable</Badge>}
          </div>
          <div className="flex flex-wrap gap-2 pt-2">
            {product.customizable && (
              <Button variant="outline" disabled title="Custom design arrives in Phase 3">
                Customize (coming soon)
              </Button>
            )}
            <Button variant="outline" disabled title="Virtual try-on arrives in Phase 7">
              Try on (coming soon)
            </Button>
          </div>
        </div>

        <div id="size-chart" className="flex flex-col gap-3 scroll-mt-8">
          <h2 className="text-lg font-semibold">Size chart (cm)</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 font-medium">Size</th>
                <th className="py-2 font-medium">Bust</th>
                <th className="py-2 font-medium">Waist</th>
                <th className="py-2 font-medium">Hip</th>
              </tr>
            </thead>
            <tbody>
              {chartRows.map((row) => (
                <tr key={row.size} className="border-b last:border-0">
                  <td className="py-2 font-medium">{row.size}</td>
                  <td className="py-2">{`${row.bustCm[0]}–${row.bustCm[1]}`}</td>
                  <td className="py-2">{`${row.waistCm[0]}–${row.waistCm[1]}`}</td>
                  <td className="py-2">{`${row.hipCm[0]}–${row.hipCm[1]}`}</td>
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
