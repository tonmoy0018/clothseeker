import { Palette } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import type { ProductCard as ProductCardData } from "@/lib/shop/catalog";
import { formatBDT } from "@/lib/money";

import { ColorSwatches } from "./color-swatches";
import { DressIllustration } from "./dress-illustration";

export function ProductCard({ product, imageUrl }: { product: ProductCardData; imageUrl?: string }) {
  const firstColor = product.colors[0];
  return (
    <Link
      href={`/products/${product.slug}`}
      className="group flex flex-col gap-3 rounded-2xl outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
      data-testid="product-card"
    >
      <div className="relative overflow-hidden rounded-2xl bg-muted ring-1 ring-black/5">
        {imageUrl ? (
          <div className="relative aspect-[4/5]">
            <Image
              src={imageUrl}
              alt={product.name}
              fill
              unoptimized
              sizes="(min-width: 1024px) 25vw, 50vw"
              className="object-cover transition-transform duration-500 ease-out group-hover:scale-105"
            />
          </div>
        ) : (
          <DressIllustration
            colorHex={firstColor?.hex ?? ""}
            label={`${product.name} in ${firstColor?.name ?? "default color"}`}
            className="aspect-[4/5] transition-transform duration-500 ease-out group-hover:scale-105"
            garmentType={product.garmentType}
          />
        )}
        {product.customizable && (
          <Badge variant="brand" className="absolute top-3 left-3 h-6 gap-1 bg-card/95 px-2.5 shadow-sm backdrop-blur">
            <Palette aria-hidden />
            Customizable
          </Badge>
        )}
      </div>
      <div className="flex flex-col gap-1 px-1">
        <span className="text-xs tracking-wide text-muted-foreground uppercase">{product.categoryName}</span>
        <span className="leading-snug font-medium decoration-brand decoration-2 underline-offset-4 group-hover:underline">{product.name}</span>
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm">From {formatBDT(product.fromPriceMinor)}</span>
          <ColorSwatches colors={product.colors} />
        </div>
      </div>
    </Link>
  );
}
