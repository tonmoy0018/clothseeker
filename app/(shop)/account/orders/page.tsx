import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { formatBDT } from "@/lib/money";
import { listOrders } from "@/lib/shop/checkout";

export const metadata: Metadata = { title: "My orders — ClothSeeker" };

const STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: "Awaiting payment",
  PAID: "Paid",
  CANCELLED: "Cancelled",
  REFUNDED: "Refunded",
};

const dateFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "Asia/Dhaka" });

export default async function OrdersPage({ searchParams }: PageProps<"/account/orders">) {
  const user = await requireUser("/account/orders");
  const orders = user.role === "CUSTOMER" ? await listOrders(getPrisma(), user) : [];
  const { placed } = await searchParams;
  // Only acknowledge an order number that belongs to this customer.
  const placedOrder = typeof placed === "string" ? orders.find((o) => o.number === placed) : undefined;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">My orders</h1>

      {placedOrder && (
        <div role="status" className="rounded-xl border border-emerald-600/30 bg-emerald-50 p-4 dark:bg-emerald-950/30">
          <p className="font-medium">Thank you! Order {placedOrder.number} is confirmed.</p>
          <p className="text-sm text-muted-foreground">We&apos;ll prepare it for shipping. Tracking arrives in Phase 4.</p>
        </div>
      )}

      {orders.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-xl border p-8">
          <p className="font-medium">You haven&apos;t placed any orders yet.</p>
          <Link href="/products" className={buttonVariants()}>
            Browse dresses
          </Link>
        </div>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border" data-testid="order-list">
          {orders.map((order) => (
            <li key={order.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="flex flex-col">
                <span className="font-medium">{order.number}</span>
                <span className="text-sm text-muted-foreground">
                  {dateFormat.format(order.createdAt)} · {order.itemCount} {order.itemCount === 1 ? "item" : "items"}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <Badge variant="secondary">{STATUS_LABEL[order.status] ?? order.status}</Badge>
                <span className="font-medium">{formatBDT(order.totalMinor)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">Order details and tracking arrive in Phase 4.</p>
    </div>
  );
}
