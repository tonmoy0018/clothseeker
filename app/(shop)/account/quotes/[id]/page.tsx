import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { requireUser } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { formatBDT } from "@/lib/money";
import { QUOTE_STATUS_LABEL } from "@/lib/quotes/rules";
import { getMyQuote } from "@/lib/quotes/service";
import { getStorage } from "@/lib/storage/supabase";

import { QuoteDecision } from "./quote-decision";

export const metadata: Metadata = { title: "Tailoring quote — ClothSeeker" };

const when = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Dhaka" });

export default async function QuotePage({ params }: PageProps<"/account/quotes/[id]">) {
  const { id } = await params;
  const user = await requireUser(`/account/quotes/${id}`);
  const quote = user.role === "CUSTOMER" ? await getMyQuote(getPrisma(), getStorage(), user, id) : null;
  if (!quote) {
    notFound();
  }

  return (
    <div className="flex flex-col gap-6">
      <Link href="/account/quotes" className="text-sm text-muted-foreground hover:text-foreground">
        ← My quotes
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Tailoring quote: {quote.productName}</h1>
        <Badge data-testid="quote-status">{QUOTE_STATUS_LABEL[quote.status]}</Badge>
      </div>

      <div className="grid gap-6 md:grid-cols-[minmax(0,320px)_1fr]">
        <div className="flex gap-3">
          <figure className="flex flex-1 flex-col gap-1">
            <span className="relative block aspect-[1200/1560] overflow-hidden rounded-xl bg-muted">
              {quote.previewUrl && <Image src={quote.previewUrl} alt="Your design" fill unoptimized className="object-contain" />}
            </span>
            <figcaption className="text-xs text-muted-foreground">Your design (size {quote.size})</figcaption>
          </figure>
          {quote.referencePhotoUrl && (
            <figure className="flex w-24 flex-col gap-1">
              <span className="relative block aspect-[3/4] overflow-hidden rounded-xl bg-muted">
                <Image src={quote.referencePhotoUrl} alt="Your reference photo" fill unoptimized className="object-cover" />
              </span>
              <figcaption className="text-xs text-muted-foreground">Your photo</figcaption>
            </figure>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <section className="flex flex-col gap-1">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase">Your notes</h2>
            <p className="whitespace-pre-line">{quote.notes}</p>
          </section>

          {quote.status === "REQUESTED" && (
            <p className="text-sm">We&apos;ll reply with a price by {when.format(new Date(quote.respondBy))}.</p>
          )}
          {quote.priceMinor !== null && (
            <section className="flex flex-col gap-1 rounded-xl border p-4" data-testid="quote-price">
              <span className="text-sm text-muted-foreground">Our price</span>
              <span className="text-2xl font-semibold">{formatBDT(quote.priceMinor)}</span>
              {quote.responseNote && <p className="whitespace-pre-line text-sm">{quote.responseNote}</p>}
              {quote.status === "QUOTED" && quote.expiresAt && (
                <span className="text-xs text-muted-foreground">Valid until {when.format(new Date(quote.expiresAt))}. Delivery is added at checkout.</span>
              )}
            </section>
          )}
          {quote.status === "DECLINED" && quote.responseNote && (
            <section className="flex flex-col gap-1 rounded-xl border p-4">
              <span className="text-sm text-muted-foreground">Sorry, we can&apos;t make this one</span>
              <p className="whitespace-pre-line text-sm">{quote.responseNote}</p>
            </section>
          )}
          {quote.status === "EXPIRED" && (
            <p className="text-sm text-muted-foreground">
              {quote.priceMinor === null ? "We couldn't reply in time. Sorry — please request a new quote from your design." : "This price has expired. You can request a new quote from your design."}
            </p>
          )}

          <QuoteDecision quoteId={quote.id} status={quote.status} inCart={quote.inCart} />
          <Link href={`/customize/${quote.productId}?design=${quote.designId}`} className="text-sm underline underline-offset-4">
            Open the design
          </Link>
        </div>
      </div>
    </div>
  );
}
