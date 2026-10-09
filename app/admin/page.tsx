import type { Metadata } from "next";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getAdminDashboard, LOW_STOCK_THRESHOLD } from "@/lib/admin/products";
import { countQuotesNeedingReply } from "@/lib/admin/quotes";
import { queueCounts } from "@/lib/production/queries";
import { requireAdmin } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";

export const metadata: Metadata = { title: "Admin — ClothSeeker" };

export default async function AdminDashboardPage() {
  // Server-side guard on every admin page and action; non-admins get a 404.
  const admin = await requireAdmin();
  const db = getPrisma();
  const [dashboard, queue, quotes] = await Promise.all([getAdminDashboard(db, admin), queueCounts(db, admin, new Date()), countQuotesNeedingReply(db, admin)]);
  const orderTiles = [
    { label: queue.overdue > 0 ? `Need acceptance (${queue.overdue} overdue)` : "Need acceptance", value: queue.needsAcceptance, href: "/admin/orders?tab=needs_acceptance" },
    { label: "To make", value: queue.toMake, href: "/admin/orders?tab=to_make" },
    { label: "Quality check", value: queue.qc, href: "/admin/orders?tab=qc" },
    { label: "To ship", value: queue.toShip, href: "/admin/orders?tab=to_ship" },
    { label: "Quotes to answer", value: quotes, href: "/admin/quotes" },
  ];

  const tiles = [
    { label: "Live dresses", value: dashboard.counts.ACTIVE, href: "/admin/products?status=ACTIVE" },
    { label: "Drafts", value: dashboard.counts.DRAFT, href: "/admin/products?status=DRAFT" },
    { label: "Archived", value: dashboard.counts.ARCHIVED, href: "/admin/products?status=ARCHIVED" },
    { label: "Templates not live", value: dashboard.inactiveTemplates, href: "/admin/products" },
  ];

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <Link href="/admin/products/new" className={buttonVariants()}>
          New dress
        </Link>
      </div>

      <section className="flex flex-col gap-3" aria-labelledby="orders-heading">
        <h2 id="orders-heading" className="text-lg font-semibold">
          Orders
        </h2>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-5" data-testid="order-tiles">
          {orderTiles.map((tile) => (
            <Link key={tile.label} href={tile.href} className="rounded-xl border p-4 hover:bg-muted">
              <div className="text-3xl font-semibold tabular-nums">{tile.value}</div>
              <div className="text-sm text-muted-foreground">{tile.label}</div>
            </Link>
          ))}
        </div>
      </section>

      <h2 className="text-lg font-semibold">Catalog</h2>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {tiles.map((tile) => (
          <Link key={tile.label} href={tile.href} className="rounded-xl border p-4 hover:bg-muted">
            <div className="text-3xl font-semibold tabular-nums">{tile.value}</div>
            <div className="text-sm text-muted-foreground">{tile.label}</div>
          </Link>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Low stock (≤ {LOW_STOCK_THRESHOLD} left)</CardTitle>
        </CardHeader>
        <CardContent>
          {dashboard.lowStock.length === 0 ? (
            <p className="text-sm text-muted-foreground">Everything live is well stocked.</p>
          ) : (
            <ul className="divide-y text-sm">
              {dashboard.lowStock.map((v) => (
                <li key={`${v.productId}-${v.size}-${v.colorName}`} className="flex items-center justify-between py-2">
                  <Link href={`/admin/products/${v.productId}`} className="hover:underline">
                    {v.productName} · {v.size} · {v.colorName}
                  </Link>
                  <span className={v.stock === 0 ? "font-medium text-destructive" : "tabular-nums"}>
                    {v.stock === 0 ? "Sold out" : `${v.stock} left`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Brand-logo flags, disputes, AI metrics and the audit log viewer arrive in Phase 8.
      </p>
    </div>
  );
}
