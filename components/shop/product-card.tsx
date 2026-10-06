import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import type { ProductCard as ProductCardData } from "@/lib/shop/catalog";
import { formatBDT } from "@/lib/money";

import { ColorSwatches } from "./color-swatches";
import { DressIllustration } from "./dress-illustration";

export function ProductCard({ product }: { product: ProductCardData }) {
  const firstColor = product.colors[0];
  return (
    <Link
      href={`/products/${product.slug}`}
      className="group flex flex-col gap-3 rounded-xl p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="product-card"
    >
      <div className="relative">
        <DressIllustration
          colorHex={firstColor?.hex ?? ""}
          label={`${product.name} in ${firstColor?.name ?? "default color"}`}
          className="aspect-[4/5] transition-transform group-hover:scale-[1.01]"
        />
        {product.customizable && (
          <Badge variant="secondary" className="absolute top-2 left-2">
            Customizable
          </Badge>
        )}
      </div>
      <div className="flex flex-col gap-1 px-1">
        <span className="text-xs text-muted-foreground">{product.categoryName}</span>
        <span className="font-medium leading-tight group-hover:underline">{product.name}</span>
        <span className="text-sm">From {formatBDT(product.fromPriceMinor)}</span>
        <ColorSwatches colors={product.colors} />
      </div>
    </Link>
  );
}
