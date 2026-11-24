import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";

export default function ProductNotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-3xl border bg-card p-10 text-center">
      <p className="font-heading text-2xl font-semibold">This item isn&apos;t available.</p>
      <p className="text-sm text-muted-foreground">It may have been removed or is no longer for sale.</p>
      <Link href="/products" className={buttonVariants({ variant: "outline", className: "mt-2" })}>
        Browse the shop
      </Link>
    </div>
  );
}
