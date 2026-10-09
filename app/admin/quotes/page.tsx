import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { listQuotesForAdmin, QUOTE_TAB_IDS, QUOTE_TABS, type QuoteTab } from "@/lib/admin/quotes";
import { requireAdmin } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { formatBDT } from "@/lib/money";
import { QUOTE_STATUS_LABEL } from "@/lib/quotes/rules";
import { expireQuotes } from "@/lib/quotes/service";
import { getStorage } from "@/lib/storage/supabase";

export const metadata: Metadata = { title: "Quotes — ClothSeeker admin" };

function timeLeft(iso: string, now: Date): string {
  const ms = new Date(iso).getTime() - now.getTime();
  if (ms <= 0) return "Overdue";
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m left`;
}

export default async function AdminQuotesPage({ searchParams }: PageProps<"/admin/quotes">) {
  const admin = await requireAdmin();
  const db = getPrisma();
  const now = new Date();
  // Same idempotent sweep the worker runs, so the lists are right even if the worker is off.
  await expireQuotes(db, now);
  const { tab: rawTab } = await searchParams;
  const tab: QuoteTab = QUOTE_TAB_IDS.find((t) => t === rawTab) ?? "needs_reply";
  const quotes = await listQuotesForAdmin(db, getStorage(), admin, tab, now);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Tailoring quotes</h1>
        <p className="text-sm text-muted-foreground">Reply within 24 hours with a price (valid for 7 days) or a decline. Unanswered requests expire automatically.</p>
      </div>
      <nav className="flex flex-wrap gap-2" aria-label="Quote lists">
        {QUOTE_TAB_IDS.map((t) => (
          <Link key={t} href={`/admin/quotes?tab=${t}`} className={buttonVariants({ variant: tab === t ? "default" : "outline", size: "sm" })} aria-current={tab === t ? "page" : undefined}>
            {QUOTE_TABS[t].label}
          </Link>
        ))}
      </nav>
      {quotes.length === 0 ? (
        <p className="rounded-xl border p-8 text-muted-foreground">Nothing here.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border" data-testid="admin-quote-list">
          {quotes.map((q) => (
            <li key={q.id}>
              <Link href={`/admin/quotes/${q.id}`} className="flex items-center gap-4 p-4 hover:bg-muted/40">
                <span className="relative size-16 shrink-0 overflow-hidden rounded-lg bg-muted">
                  {q.previewUrl && <Image src={q.previewUrl} alt="" fill unoptimized className="object-contain" />}
                </span>
                <span className="flex flex-1 flex-col">
                  <span className="font-medium">
                    {q.productName} · size {q.size}
                  </span>
                  <span className="line-clamp-1 text-sm text-muted-foreground">{q.notes}</span>
                </span>
                <span className="flex flex-col items-end gap-1 text-sm">
                  <Badge variant="secondary">{QUOTE_STATUS_LABEL[q.status]}</Badge>
                  {q.status === "REQUESTED" && <span className={timeLeft(q.respondBy, now) === "Overdue" ? "text-destructive" : ""}>{timeLeft(q.respondBy, now)}</span>}
                  {q.priceMinor !== null && <span className="font-medium">{formatBDT(q.priceMinor)}</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
