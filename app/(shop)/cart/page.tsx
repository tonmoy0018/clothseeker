import type { Metadata } from "next";
import Link from "next/link";

import { DressIllustration } from "@/components/shop/dress-illustration";
import { buttonVariants } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { formatBDT } from "@/lib/money";
import { getCart } from "@/lib/shop/cart";

import { LineControls, PayNowForm } from "./cart-forms";

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

  const cart = await getCart(getPrisma(), user);
  // Fresh key per render: a double-submit of this page reuses it, so it can't create two orders.
  const idempotencyKey = crypto.randomUUID();

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
            <li key={line.itemId} className="flex gap-4 p-4">
              <DressIllustration
                colorHex={line.colorHex}
                label={`${line.productName} in ${line.colorName}`}
                className="size-20 shrink-0"
              />
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
          <span className="text-muted-foreground">Calculated at checkout (Phase 4)</span>
        </div>
        <div className="flex justify-between border-t pt-3 font-semibold">
          <span>Total</span>
          <span data-testid="cart-total">{formatBDT(cart.totalMinor)}</span>
        </div>
        {!cart.canCheckout && (
          <p className="text-sm text-destructive">Update or remove the highlighted items before paying.</p>
        )}
        <PayNowForm idempotencyKey={idempotencyKey} disabled={!cart.canCheckout} />
      </aside>
    </div>
  );
}
