import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { formatBDT, lineTotalMinor } from "@/lib/money";
import { quoteCheckout, type CheckoutQuote } from "@/lib/orders/checkout";
import { OrderError } from "@/lib/orders/errors";
import { BUCKETS } from "@/lib/storage/buckets";
import { getStorage } from "@/lib/storage/supabase";

import { CheckoutForm } from "./checkout-form";

export const metadata: Metadata = { title: "Checkout — ClothSeeker" };

export default async function CheckoutPage() {
  const user = await requireUser("/checkout");
  if (user.role !== "CUSTOMER") {
    return <p className="rounded-xl border p-8">Only customer accounts can check out.</p>;
  }

  const db = getPrisma();
  const storage = getStorage();
  let quote: CheckoutQuote;
  try {
    quote = await quoteCheckout(db, storage, user, "INSIDE_DHAKA");
  } catch (error) {
    if (error instanceof OrderError) {
      return (
        <div className="flex flex-col items-start gap-3 rounded-xl border p-8" data-testid="checkout-blocked">
          <h1 className="text-xl font-semibold">Your cart needs attention</h1>
          <p className="text-muted-foreground">{error.message}</p>
          <Link href="/cart" className={buttonVariants({ variant: "outline" })}>
            Back to cart
          </Link>
        </div>
      );
    }
    throw error;
  }

  const designs = await db.design.findMany({
    where: { id: { in: quote.lines.flatMap((l) => (l.kind === "CUSTOM_DESIGN" ? [l.design.designId] : [])) }, customerId: user.id },
    select: { id: true, previewKey: true },
  });
  const previews = await storage.signReadUrls(BUCKETS.designAssets, designs.flatMap((d) => (d.previewKey ? [d.previewKey] : [])));
  const previewFor = (designId: string) => {
    const key = designs.find((d) => d.id === designId)?.previewKey;
    return key ? previews.get(key) : undefined;
  };

  // Prefill from the customer's most recent delivery address.
  const last = await db.order.findFirst({
    where: { customerId: user.id, shippingLine1: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { shippingName: true, shippingPhone: true, shippingLine1: true, shippingLine2: true, shippingCity: true, shippingPostalCode: true, deliveryZone: true },
  });

  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_380px]">
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold">Checkout</h1>
        <CheckoutForm
          idempotencyKey={crypto.randomUUID()}
          subtotalMinor={quote.subtotalMinor}
          defaults={{
            name: last?.shippingName ?? user.name ?? "",
            phone: last?.shippingPhone ?? "",
            line1: last?.shippingLine1 ?? "",
            line2: last?.shippingLine2 ?? "",
            city: last?.shippingCity ?? "",
            postalCode: last?.shippingPostalCode ?? "",
            zone: last?.deliveryZone ?? "INSIDE_DHAKA",
          }}
        />
      </div>

      <aside className="flex h-fit flex-col gap-4 rounded-xl border p-5">
        <h2 className="font-semibold">Your order</h2>
        <ul className="flex flex-col gap-3" data-testid="checkout-lines">
          {quote.lines.map((line) => {
            const preview = line.kind === "CUSTOM_DESIGN" ? previewFor(line.design.designId) : undefined;
            return (
              <li key={line.cartItemId} className="flex items-center gap-3 text-sm">
                {line.kind === "CUSTOM_DESIGN" && (
                  <div className="relative size-14 shrink-0 overflow-hidden rounded-lg bg-muted">
                    {preview && <Image src={preview} alt="" fill unoptimized className="object-contain" />}
                  </div>
                )}
                <div className="flex flex-1 flex-col">
                  <span className="font-medium">
                    {line.kind === "CUSTOM_DESIGN" ? `${line.design.productName} — your design` : line.kind === "QUOTE" ? `${line.productName} — tailoring quote` : line.productName}
                  </span>
                  <span className="text-muted-foreground">
                    {line.kind === "CUSTOM_DESIGN"
                      ? `Size ${line.design.spec.size} · made to order`
                      : line.kind === "QUOTE"
                        ? `Size ${line.spec.size} · made to order at the quoted price`
                        : `Size ${line.size} · ${line.colorName} · × ${line.quantity}`}
                  </span>
                </div>
                <span>{formatBDT(lineTotalMinor(line.unitPriceMinor, line.quantity))}</span>
              </li>
            );
          })}
        </ul>
        {quote.lines.some((l) => l.kind === "CUSTOM_DESIGN") && (
          <p className="text-xs text-muted-foreground">
            Custom designs are made to order. ClothSeeker confirms within 24 hours; if we can&apos;t make it, you get a full refund.
          </p>
        )}
      </aside>
    </div>
  );
}
