"use client";

import Image from "next/image";
import { useActionState, useMemo, useState } from "react";

import { DressIllustration } from "@/components/shop/dress-illustration";
import type { GarmentType } from "@/lib/catalog/garment-types";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/select";
import type { Size } from "@/lib/generated/prisma/enums";
import { formatBDT } from "@/lib/money";
import type { ProductVariantOption } from "@/lib/shop/catalog";
import { cn } from "@/lib/utils";

import { buyNow, type BuyNowState } from "./actions";

type PurchasePanelProps = {
  garmentType: GarmentType;
  productId: string;
  slug: string;
  name: string;
  variants: readonly ProductVariantOption[];
  /** Sizes this dress is made in, in display order. */
  sizes: readonly Size[];
  colors: readonly { name: string; hex: string }[];
  /** Signed photo URLs; when empty, a color illustration is shown instead. */
  photos: readonly string[];
  /** Shown above the name (the category) and under the Buy button (other ways to get it, delivery notes). */
  eyebrow?: React.ReactNode;
  children?: React.ReactNode;
};

const initialState: BuyNowState = {};

/**
 * Size/color picker. Availability and prices shown here are display-only: the server
 * re-resolves the variant, price and stock when the form is submitted.
 */
export function PurchasePanel({ productId, slug, name, variants, sizes, colors, photos, garmentType, eyebrow, children }: PurchasePanelProps) {
  const firstAvailable = variants.find((v) => v.available > 0);
  const [color, setColor] = useState(firstAvailable?.colorName ?? colors[0]?.name ?? "");
  const [size, setSize] = useState<Size | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [photoIndex, setPhotoIndex] = useState(0);
  const activePhoto = photos[photoIndex] ?? photos[0];
  const [state, formAction, pending] = useActionState(buyNow, initialState);

  const selected = useMemo(
    () => variants.find((v) => v.colorName === color && v.size === size) ?? null,
    [variants, color, size],
  );
  const colorHex = colors.find((c) => c.name === color)?.hex ?? "";
  const pricesForColor = variants.filter((v) => v.colorName === color).map((v) => v.priceMinor);
  const fromPrice = pricesForColor.length > 0 ? Math.min(...pricesForColor) : null;
  const canBuy = selected !== null && selected.available > 0;

  function availableFor(s: Size): number {
    return variants.find((v) => v.colorName === color && v.size === s)?.available ?? 0;
  }

  return (
    <div className="grid gap-8 md:grid-cols-2 lg:gap-12">
      {activePhoto ? (
        <div className="flex flex-col gap-3 md:sticky md:top-6 md:self-start">
          <div className="relative aspect-[4/5] overflow-hidden rounded-3xl bg-muted ring-1 ring-black/5">
            <Image src={activePhoto} alt={name} fill unoptimized priority sizes="(min-width: 768px) 50vw, 100vw" className="object-cover" />
          </div>
          {photos.length > 1 && (
            <div className="flex gap-2" role="group" aria-label="Photos">
              {photos.map((url, index) => (
                <button
                  key={url}
                  type="button"
                  onClick={() => setPhotoIndex(index)}
                  aria-label={`Show photo ${index + 1}`}
                  aria-pressed={index === photoIndex}
                  className={cn(
                    "relative size-16 overflow-hidden rounded-xl bg-muted ring-1 ring-black/10 transition",
                    index === photoIndex && "ring-2 ring-brand",
                  )}
                >
                  <Image src={url} alt="" fill unoptimized sizes="64px" className="object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <DressIllustration colorHex={colorHex} label={`${name} in ${color}`} className="aspect-[4/5]" garmentType={garmentType} />
      )}

      <div className="flex min-w-0 flex-col gap-6">
      <form action={formAction} className="flex flex-col gap-6">
        <input type="hidden" name="productId" value={productId} />
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="color" value={color} />
        <input type="hidden" name="size" value={size ?? ""} />
        <input type="hidden" name="quantity" value={quantity} />

        <div className="flex flex-col gap-2">
          {eyebrow}
          <h1 className="text-3xl leading-tight font-semibold sm:text-4xl">{name}</h1>
          <p className="text-2xl" data-testid="price">
            {selected ? formatBDT(selected.priceMinor) : fromPrice !== null ? `From ${formatBDT(fromPrice)}` : ""}
          </p>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">
            Color: <span className="font-normal">{color}</span>
          </legend>
          <div className="flex flex-wrap gap-2">
            {colors.map((c) => (
              <button
                key={c.name}
                type="button"
                onClick={() => {
                  setColor(c.name);
                  setQuantity(1);
                }}
                aria-pressed={c.name === color}
                aria-label={c.name}
                title={c.name}
                className={cn(
                  "size-9 rounded-full ring-1 ring-black/15 ring-offset-background transition outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  c.name === color && "ring-2 ring-foreground ring-offset-2",
                )}
                style={{ backgroundColor: /^#[0-9a-f]{6}$/i.test(c.hex) ? c.hex : undefined }}
              />
            ))}
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">Size</legend>
          <div className="flex flex-wrap gap-2">
            {sizes.map((s) => {
              const available = availableFor(s);
              const exists = variants.some((v) => v.colorName === color && v.size === s);
              return (
                <button
                  key={s}
                  type="button"
                  disabled={!exists || available === 0}
                  onClick={() => {
                    setSize(s);
                    setQuantity(1);
                  }}
                  aria-pressed={s === size}
                  className={cn(
                    "h-10 min-w-12 rounded-full border border-input bg-card px-4 text-sm font-medium transition disabled:cursor-not-allowed disabled:bg-transparent disabled:font-normal disabled:text-muted-foreground disabled:line-through",
                    s === size ? "border-primary bg-primary text-primary-foreground" : "hover:border-foreground/40",
                  )}
                >
                  {s}
                </button>
              );
            })}
          </div>
          {selected && selected.available > 0 && selected.available <= 3 && (
            <p className="text-sm text-amber-700 dark:text-amber-400">Only {selected.available} left</p>
          )}
          <a href="#size-chart" className="self-start text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground">
            Size chart
          </a>
        </fieldset>

        {selected && selected.available > 1 && (
          <div className="flex items-center gap-2">
            <label htmlFor="quantity-select" className="text-sm font-medium">
              Quantity
            </label>
            <NativeSelect id="quantity-select" value={quantity} onChange={(e) => setQuantity(Number(e.target.value))}>
              {Array.from({ length: selected.available }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </NativeSelect>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Button type="submit" size="lg" variant="brand" disabled={!canBuy || pending} className="h-12 text-base">
            {pending ? "Adding…" : size ? "Buy now" : "Select a size"}
          </Button>
          {state.error && (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          )}
        </div>
      </form>
      {children}
      </div>
    </div>
  );
}
