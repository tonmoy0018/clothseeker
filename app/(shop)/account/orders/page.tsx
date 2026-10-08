import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { formatBDT } from "@/lib/money";
import { statusLabel } from "@/lib/orders/labels";
import { listOrders } from "@/lib/orders/queries";

export const metadata: Metadata = { title: "My orders — ClothSeeker" };

const dateFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "Asia/Dhaka" });

export default async function OrdersPage() {
  const user = await requireUser("/account/orders");
  const orders = user.role === "CUSTOMER" ? await listOrders(getPrisma(), user) : [];

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">My orders</h1>
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
            <li key={order.id}>
              <Link href={`/account/orders/${order.id}`} className="flex flex-wrap items-center justify-between gap-3 p-4 hover:bg-muted/40">
                <div className="flex flex-col">
                  <span className="font-medium">{order.number}</span>
                  <span className="text-sm text-muted-foreground">
                    {dateFormat.format(order.createdAt)} · {order.itemCount} {order.itemCount === 1 ? "item" : "items"}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant="secondary">{statusLabel(order.status)}</Badge>
                  <span className="font-medium">{formatBDT(order.totalMinor)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
