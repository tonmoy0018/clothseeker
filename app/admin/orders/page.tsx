import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requireAdmin } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { ITEM_STATUS_LABEL } from "@/lib/orders/labels";
import { getPaymentProvider } from "@/lib/payments";
import { expireOverdueAcceptances } from "@/lib/production/acceptance";
import { listQueue, QUEUE_TABS, queueCounts, queueFiltersSchema, TAB_IDS, type QueueTab } from "@/lib/production/queries";
import { BUCKETS } from "@/lib/storage/buckets";
import { getStorage } from "@/lib/storage/supabase";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Orders — ClothSeeker admin" };

const KIND_LABEL = { READY_MADE: "Ready-made", CUSTOM_DESIGN: "Custom", QUOTE: "Quote" } as const;
const date = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Dhaka" });

function deadline(acceptBy: Date | null, now: Date): { text: string; overdue: boolean } | null {
  if (!acceptBy) return null;
  const ms = acceptBy.getTime() - now.getTime();
  if (ms <= 0) return { text: "Overdue — refunding", overdue: true };
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return { text: `${hours}h ${minutes}m left`, overdue: false };
}

export default async function AdminOrdersPage({ searchParams }: PageProps<"/admin/orders">) {
  const admin = await requireAdmin();
  const db = getPrisma();
  const now = new Date();
  // Same idempotent sweep the worker runs, so the queue is correct even if the worker is off.
  await expireOverdueAcceptances(db, getPaymentProvider(), now);

  const params = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
  const filters = queueFiltersSchema.parse({ tab: first(params.tab), kind: first(params.kind), q: first(params.q) });
  const [rows, counts] = await Promise.all([listQueue(db, admin, filters), queueCounts(db, admin, now)]);
  const previews = await getStorage().signReadUrls(BUCKETS.designAssets, rows.flatMap((r) => (r.previewKey ? [r.previewKey] : [])));

  const tabCount: Partial<Record<QueueTab, number>> = {
    needs_acceptance: counts.needsAcceptance,
    to_make: counts.toMake,
    qc: counts.qc,
    to_ship: counts.toShip,
  };
  const href = (tab: QueueTab) => `/admin/orders?tab=${tab}${filters.kind ? `&kind=${filters.kind}` : ""}`;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Orders</h1>

      <nav className="flex flex-wrap gap-2" aria-label="Queue">
        {TAB_IDS.map((tab) => (
          <Link key={tab} href={href(tab)} className={buttonVariants({ variant: filters.tab === tab ? "default" : "outline", size: "sm" })} aria-current={filters.tab === tab ? "page" : undefined}>
            {QUEUE_TABS[tab].label}
            {tabCount[tab] ? ` (${tabCount[tab]})` : ""}
          </Link>
        ))}
      </nav>

      <form method="get" className="flex flex-wrap items-center gap-2" aria-label="Filter orders">
        <input type="hidden" name="tab" value={filters.tab} />
        <Input name="q" placeholder="Order number" defaultValue={filters.q} className="w-48" />
        <select name="kind" defaultValue={filters.kind ?? ""} className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm" aria-label="Kind">
          <option value="">All kinds</option>
          <option value="READY_MADE">Ready-made</option>
          <option value="CUSTOM_DESIGN">Custom</option>
          <option value="QUOTE">Quote</option>
        </select>
        <button type="submit" className={buttonVariants({ variant: "outline", size: "sm" })}>
          Filter
        </button>
      </form>

      {rows.length === 0 ? (
        <p className="rounded-xl border p-8 text-muted-foreground">Nothing here right now.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm" data-testid="order-queue">
            <thead className="bg-muted/50 text-left text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">Item</th>
                <th className="p-3 font-medium">Order</th>
                <th className="p-3 font-medium">Kind</th>
                <th className="p-3 font-medium">Status</th>
                <th className="p-3 font-medium">Paid</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row) => {
                const due = row.status === "AWAITING_ACCEPTANCE" ? deadline(row.acceptBy, now) : null;
                const preview = row.previewKey ? previews.get(row.previewKey) : undefined;
                return (
                  <tr key={row.itemId} className="hover:bg-muted/30">
                    <td className="p-3">
                      <Link href={`/admin/orders/${row.orderId}#item-${row.itemId}`} className="flex items-center gap-3 font-medium hover:underline">
                        {preview ? (
                          <Image src={preview} alt="" width={40} height={52} unoptimized className="h-13 w-10 rounded object-contain bg-muted" />
                        ) : (
                          <span className="h-13 w-10 rounded bg-muted" aria-hidden />
                        )}
                        <span>
                          {row.productName}
                          <span className="block text-xs font-normal text-muted-foreground">
                            Size {row.size}
                            {row.colorName ? ` · ${row.colorName}` : ""} · × {row.quantity}
                          </span>
                        </span>
                      </Link>
                    </td>
                    <td className="p-3">{row.orderNumber}</td>
                    <td className="p-3">{KIND_LABEL[row.kind]}</td>
                    <td className="p-3">
                      <Badge variant="secondary">{ITEM_STATUS_LABEL[row.status]}</Badge>
                      {due && <span className={cn("ml-2 text-xs", due.overdue ? "text-destructive" : "text-amber-700 dark:text-amber-400")}>{due.text}</span>}
                    </td>
                    <td className="p-3 text-muted-foreground">{row.paidAt ? date.format(row.paidAt) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
