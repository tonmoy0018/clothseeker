import type { Metadata } from "next";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { DISPUTE_TABS, listDisputes, type DisputeTab } from "@/lib/admin/disputes";
import { requireAdmin } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { formatBDT } from "@/lib/money";

export const metadata: Metadata = { title: "Disputes — ClothSeeker admin" };

const when = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Dhaka" });
const OUTCOME = { OPEN: "Open", RESOLVED_REFUND: "Refunded", RESOLVED_REJECTED: "No refund" } as const;

export default async function AdminDisputesPage({ searchParams }: PageProps<"/admin/disputes">) {
  const admin = await requireAdmin();
  const { tab: rawTab } = await searchParams;
  const tab: DisputeTab = DISPUTE_TABS.find((t) => t === rawTab) ?? "open";
  const disputes = await listDisputes(getPrisma(), admin, tab);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Disputes</h1>
        <p className="text-sm text-muted-foreground">Problems customers reported with delivered items. Check the evidence, then refund or explain why not.</p>
      </div>
      <nav className="flex gap-2" aria-label="Dispute lists">
        {DISPUTE_TABS.map((t) => (
          <Link key={t} href={`/admin/disputes?tab=${t}`} className={buttonVariants({ variant: tab === t ? "default" : "outline", size: "sm" })} aria-current={tab === t ? "page" : undefined}>
            {t === "open" ? "Open" : "Resolved"}
          </Link>
        ))}
      </nav>
      {disputes.length === 0 ? (
        <p className="rounded-xl border p-8 text-muted-foreground">Nothing here.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border" data-testid="dispute-list">
          {disputes.map((d) => (
            <li key={d.id}>
              <Link href={`/admin/disputes/${d.id}`} className="flex flex-wrap items-center justify-between gap-3 p-4 hover:bg-muted/40">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium">
                    {d.orderNumber} · {d.productName}
                  </span>
                  <span className="line-clamp-1 text-sm text-muted-foreground">{d.reason}</span>
                </span>
                <span className="flex flex-col items-end text-sm">
                  <span>{OUTCOME[d.status]}</span>
                  <span className="text-muted-foreground">
                    {when.format(d.createdAt)} · {formatBDT(d.amountMinor)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
