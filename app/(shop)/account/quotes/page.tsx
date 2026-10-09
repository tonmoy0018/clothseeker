import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { formatBDT } from "@/lib/money";
import { QUOTE_STATUS_LABEL } from "@/lib/quotes/rules";
import { listMyQuotes } from "@/lib/quotes/service";
import { getStorage } from "@/lib/storage/supabase";

export const metadata: Metadata = { title: "My quotes — ClothSeeker" };

export default async function QuotesPage() {
  const user = await requireUser("/account/quotes");
  const quotes = user.role === "CUSTOMER" ? await listMyQuotes(getPrisma(), getStorage(), user) : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">My tailoring quotes</h1>
        <p className="text-sm text-muted-foreground">For designs started from a dress photo that need special tailoring. We reply within 24 hours; a price is valid for 7 days.</p>
      </div>
      {quotes.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-xl border p-8">
          <p className="font-medium">You haven&apos;t requested any quotes yet.</p>
          <Link href="/design/start" className={buttonVariants()}>
            Start from a dress photo
          </Link>
        </div>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border" data-testid="quote-list">
          {quotes.map((q) => (
            <li key={q.id}>
              <Link href={`/account/quotes/${q.id}`} className="flex items-center gap-4 p-4 hover:bg-muted/40">
                <span className="relative size-16 shrink-0 overflow-hidden rounded-lg bg-muted">
                  {q.previewUrl && <Image src={q.previewUrl} alt="" fill unoptimized className="object-contain" />}
                </span>
                <span className="flex flex-1 flex-col">
                  <span className="font-medium">{q.productName}</span>
                  <span className="line-clamp-1 text-sm text-muted-foreground">{q.notes}</span>
                </span>
                <span className="flex flex-col items-end gap-1">
                  <Badge variant={q.status === "QUOTED" ? "default" : "secondary"}>{QUOTE_STATUS_LABEL[q.status]}</Badge>
                  {q.priceMinor !== null && <span className="text-sm font-medium">{formatBDT(q.priceMinor)}</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
