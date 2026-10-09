import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { getQuoteForAdmin } from "@/lib/admin/quotes";
import { requireAdmin } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { formatBDT } from "@/lib/money";
import { QUOTE_STATUS_LABEL } from "@/lib/quotes/rules";
import { getStorage } from "@/lib/storage/supabase";

import { RespondForm } from "./respond-form";

export const metadata: Metadata = { title: "Quote — ClothSeeker admin" };

const when = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Dhaka" });

/** Everything the team needs to price the work. No customer contact details. */
export default async function AdminQuotePage({ params }: PageProps<"/admin/quotes/[id]">) {
  const admin = await requireAdmin();
  const { id } = await params;
  const quote = await getQuoteForAdmin(getPrisma(), getStorage(), admin, id);
  if (!quote) {
    notFound();
  }
  const spec = quote.spec;

  return (
    <div className="flex flex-col gap-6">
      <Link href="/admin/quotes" className="text-sm text-muted-foreground hover:text-foreground">
        ← Quotes
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">
          {quote.productName} · size {quote.size}
        </h1>
        <Badge data-testid="admin-quote-status">{QUOTE_STATUS_LABEL[quote.status]}</Badge>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,460px)_1fr]">
        <div className="flex gap-3">
          <figure className="flex flex-1 flex-col gap-1">
            <span className="relative block aspect-[1200/1560] overflow-hidden rounded-xl bg-muted">
              {quote.previewUrl && <Image src={quote.previewUrl} alt="Customer's design" fill unoptimized className="object-contain" />}
            </span>
            <figcaption className="text-xs text-muted-foreground">Design (frozen when requested)</figcaption>
          </figure>
          {quote.referencePhotoUrl && (
            <figure className="flex w-36 flex-col gap-1">
              <span className="relative block aspect-[3/4] overflow-hidden rounded-xl bg-muted">
                <Image src={quote.referencePhotoUrl} alt="Customer's reference photo" fill unoptimized className="object-cover" />
              </span>
              <figcaption className="text-xs text-muted-foreground">Reference photo</figcaption>
            </figure>
          )}
        </div>

        <div className="flex flex-col gap-5">
          <section className="flex flex-col gap-1">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase">Customer&apos;s notes</h2>
            <p className="whitespace-pre-line" data-testid="admin-quote-notes">
              {quote.notes}
            </p>
          </section>
          {spec && (
            <section className="flex flex-col gap-1 text-sm">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase">Design</h2>
              <p>
                Neckline {spec.styleOptions.neckline} · sleeves {spec.styleOptions.sleeveLength} · length {spec.styleOptions.dressLength}
              </p>
              <p>
                {Object.entries(spec.parts)
                  .map(([region, part]) => `${region}: ${part.color}${part.pattern ? ` with ${part.pattern.id}` : ""}`)
                  .join(" · ") || "Original colours"}
              </p>
              <p>{spec.layers.length} added item(s) (text, images, decorations)</p>
            </section>
          )}
          <p className="text-sm text-muted-foreground">
            Requested {when.format(new Date(quote.createdAt))}. Reply by {when.format(new Date(quote.respondBy))}.
          </p>
          {quote.status === "REQUESTED" ? (
            <RespondForm quoteId={quote.id} />
          ) : (
            <section className="flex flex-col gap-1 rounded-xl border p-4 text-sm">
              {quote.priceMinor !== null && <span className="text-lg font-semibold">{formatBDT(quote.priceMinor)}</span>}
              {quote.responseNote && <p className="whitespace-pre-line">{quote.responseNote}</p>}
              {quote.expiresAt && quote.status === "QUOTED" && <span className="text-muted-foreground">Valid until {when.format(new Date(quote.expiresAt))}</span>}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
