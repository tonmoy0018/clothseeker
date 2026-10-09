import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { DressIllustration } from "@/components/shop/dress-illustration";
import { buttonVariants } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { formatBDT } from "@/lib/money";
import { getCart, type CartLine } from "@/lib/shop/cart";
import { BUCKETS } from "@/lib/storage/buckets";
import { getStorage } from "@/lib/storage/supabase";

import { LineControls, RemoveOnly } from "./cart-forms";

export const metadata: Metadata = { title: "Cart — ClothSeeker" };

export default async function CartPage() {
  const user = await requireUser("/cart");

  if (user.role !== "CUSTOMER") {
    return (
      <div className="rounded-xl border p-8">
        <p className="font-medium">Admin accounts don&apos;t have a cart.</p>
        <p className="text-sm text-muted-foreground">Sign in with a customer account to shop.</p>
      </div>
    );
  }

  const storage = getStorage();
  const cart = await getCart(getPrisma(), storage, user);
  const previews = await storage.signReadUrls(
    BUCKETS.designAssets,
    cart.lines.flatMap((l) => ((l.kind === "CUSTOM_DESIGN" || l.kind === "QUOTE") && l.previewKey ? [l.previewKey] : [])),
  );

  if (cart.lines.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-xl border p-8">
        <h1 className="text-2xl font-semibold">Your cart is empty</h1>
        <p className="text-muted-foreground">Find a dress you love and it will appear here.</p>
        <Link href="/products" className={buttonVariants()}>
          Browse dresses
        </Link>
      </div>
    );
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
      <section className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Your cart</h1>
        <ul className="flex flex-col divide-y rounded-xl border" data-testid="cart-lines">
          {cart.lines.map((line) => (
            <CartRow key={line.itemId} line={line} previewUrl={(line.kind === "CUSTOM_DESIGN" || line.kind === "QUOTE") && line.previewKey ? previews.get(line.previewKey) : undefined} />
          ))}
        </ul>
      </section>

      <aside className="flex h-fit flex-col gap-4 rounded-xl border p-5">
        <h2 className="font-semibold">Order summary</h2>
        <div className="flex justify-between text-sm">
          <span>Items</span>
          <span>{cart.itemCount}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span>Delivery</span>
          <span className="text-muted-foreground">Chosen at checkout</span>
        </div>
        <div className="flex justify-between border-t pt-3 font-semibold">
          <span>Subtotal</span>
          <span data-testid="cart-total">{formatBDT(cart.totalMinor)}</span>
        </div>
        {!cart.canCheckout && <p className="text-sm text-destructive">Update or remove the highlighted items before checking out.</p>}
        {cart.canCheckout ? (
          <Link href="/checkout" className={buttonVariants({ size: "lg" })}>
            Checkout
          </Link>
        ) : (
          <span className={buttonVariants({ size: "lg", className: "pointer-events-none opacity-50" })} aria-disabled="true">
            Checkout
          </span>
        )}
        {cart.hasCustomDesigns && (
          <p className="text-xs text-muted-foreground">Custom designs are made to order after ClothSeeker accepts them (within 24 hours).</p>
        )}
      </aside>
    </div>
  );
}

function CartRow({ line, previewUrl }: { line: CartLine; previewUrl: string | undefined }) {
  if (line.kind === "QUOTE") {
    return (
      <li className="flex gap-4 p-4" data-testid="quote-line">
        <div className="relative size-20 shrink-0 overflow-hidden rounded-xl bg-muted">
          {previewUrl && <Image src={previewUrl} alt={`Quoted design for ${line.productName}`} fill unoptimized className="object-contain" />}
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <Link href={`/account/quotes/${line.quoteId}`} className="font-medium hover:underline">
            {line.productName} — tailoring quote
          </Link>
          <span className="text-sm text-muted-foreground">
            Size {line.size} · Made to order{line.expiresAt && !line.issue ? ` · Price valid until ${new Date(line.expiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Dhaka" })}` : ""}
          </span>
          {line.issue && <span className="text-sm text-destructive">{line.issue}</span>}
        </div>
        <div className="flex flex-col items-end justify-between gap-2">
          <span className="font-medium">{line.issue ? "—" : formatBDT(line.lineTotalMinor)}</span>
          <RemoveOnly itemId={line.itemId} />
        </div>
      </li>
    );
  }
  if (line.kind === "CUSTOM_DESIGN") {
    return (
      <li className="flex gap-4 p-4" data-testid="custom-line">
        <div className="relative size-20 shrink-0 overflow-hidden rounded-xl bg-muted">
          {previewUrl && <Image src={previewUrl} alt={`Your design for ${line.productName}`} fill unoptimized className="object-contain" />}
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <Link href={`/customize/${line.productId}?design=${line.designId}`} className="font-medium hover:underline">
            {line.productName} — your design
          </Link>
          <span className="text-sm text-muted-foreground">Size {line.size} · Made to order</span>
          {line.issue && <span className="text-sm text-destructive">{line.issue}</span>}
        </div>
        <div className="flex flex-col items-end justify-between gap-2">
          <span className="font-medium">{line.issue ? "—" : formatBDT(line.lineTotalMinor)}</span>
          <RemoveOnly itemId={line.itemId} />
        </div>
      </li>
    );
  }
  return (
    <li className="flex gap-4 p-4">
      <DressIllustration colorHex={line.colorHex} label={`${line.productName} in ${line.colorName}`} className="size-20 shrink-0" />
      <div className="flex flex-1 flex-col gap-1">
        <Link href={`/products/${line.productSlug}`} className="font-medium hover:underline">
          {line.productName}
        </Link>
        <span className="text-sm text-muted-foreground">
          Size {line.size} · {line.colorName}
        </span>
        <span className="text-sm">{formatBDT(line.unitPriceMinor)} each</span>
        {line.issue && <span className="text-sm text-destructive">{line.issue}</span>}
      </div>
      <div className="flex flex-col items-end justify-between gap-2">
        <span className="font-medium">{formatBDT(line.lineTotalMinor)}</span>
        <LineControls itemId={line.itemId} quantity={line.quantity} />
      </div>
    </li>
  );
}
