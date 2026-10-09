import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { getDisputeEvidence } from "@/lib/admin/disputes";
import { requireAdmin } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { formatBDT } from "@/lib/money";
import { statusLabel } from "@/lib/orders/labels";
import { getStorage } from "@/lib/storage/supabase";

import { ResolveForm } from "./resolve-form";

export const metadata: Metadata = { title: "Dispute — ClothSeeker admin" };

const when = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Dhaka" });
const OUTCOME = { OPEN: "Open", RESOLVED_REFUND: "Refunded", RESOLVED_REJECTED: "No refund" } as const;

/** Only the evidence needed to decide. No address or phone. */
export default async function AdminDisputePage({ params }: PageProps<"/admin/disputes/[id]">) {
  const admin = await requireAdmin();
  const { id } = await params;
  const d = await getDisputeEvidence(getPrisma(), getStorage(), admin, id);
  if (!d) {
    notFound();
  }

  return (
    <div className="flex flex-col gap-6">
      <Link href="/admin/disputes" className="text-sm text-muted-foreground hover:text-foreground">
        ← Disputes
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">
          {d.item.productName} · {d.item.orderNumber}
        </h1>
        <Badge data-testid="dispute-status">{OUTCOME[d.status]}</Badge>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase">Customer&apos;s report</h2>
          <p className="whitespace-pre-line" data-testid="dispute-reason">
            {d.reason}
          </p>
          <p className="text-xs text-muted-foreground">Reported {when.format(d.createdAt)}</p>
          {d.customerPhotoUrls.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {d.customerPhotoUrls.map((url, i) => (
                <a key={url} href={url} target="_blank" rel="noreferrer" className="relative block h-40 w-32 overflow-hidden rounded-lg bg-muted">
                  <Image src={url} alt={`Customer photo ${i + 1}`} fill unoptimized className="object-cover" />
                </a>
              ))}
            </div>
          )}

          <h2 className="mt-2 text-sm font-semibold text-muted-foreground uppercase">What was ordered</h2>
          <div className="flex gap-3">
            {d.item.previewUrl && (
              <span className="relative block h-40 w-32 overflow-hidden rounded-lg bg-muted">
                <Image src={d.item.previewUrl} alt="Approved design" fill unoptimized className="object-contain" />
              </span>
            )}
            <div className="flex flex-col gap-1 text-sm">
              <span>
                Size {d.item.size}
                {d.item.colorName ? ` · ${d.item.colorName}` : ""} · × {d.item.quantity}
              </span>
              <span>{formatBDT(d.item.amountMinor)}</span>
              <span className="text-muted-foreground">Item status: {statusLabel(d.item.status)}</span>
              {d.item.printFiles.map((f) =>
                f.url ? (
                  <a key={f.label} href={f.url} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                    Print file: {f.label}
                  </a>
                ) : null,
              )}
              <Link href={`/admin/orders/${d.item.orderId}#item-${d.item.id}`} className="underline underline-offset-4">
                Open the order
              </Link>
            </div>
          </div>

          {d.item.qcPhotos.length > 0 && (
            <>
              <h2 className="mt-2 text-sm font-semibold text-muted-foreground uppercase">Our QC photos</h2>
              <div className="flex flex-wrap gap-2">
                {d.item.qcPhotos.map((q) =>
                  q.url ? (
                    <figure key={q.url} className="flex flex-col gap-1">
                      <span className="relative block h-40 w-32 overflow-hidden rounded-lg bg-muted">
                        <Image src={q.url} alt={`QC ${q.side.toLowerCase()}`} fill unoptimized className="object-cover" />
                      </span>
                      <figcaption className="text-xs text-muted-foreground">
                        {q.side === "FRONT" ? "Front" : "Back"} · {when.format(q.createdAt)}
                      </figcaption>
                    </figure>
                  ) : null,
                )}
              </div>
            </>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase">Timeline</h2>
          <ol className="flex flex-col gap-1.5 border-l pl-4 text-sm" data-testid="dispute-timeline">
            {d.timeline.map((e) => (
              <li key={`${e.at.toISOString()}-${e.status}`}>
                <span className="text-muted-foreground">{when.format(e.at)}</span> — {statusLabel(e.status)}
                <span className="text-muted-foreground"> ({e.actor.toLowerCase()})</span>
                {e.note && <span className="block text-xs text-muted-foreground">{e.note}</span>}
              </li>
            ))}
            {d.courier.map((e) => (
              <li key={`c-${e.at.toISOString()}-${e.status}`}>
                <span className="text-muted-foreground">{when.format(e.at)}</span> — courier: {e.status.toLowerCase().replaceAll("_", " ")}
              </li>
            ))}
          </ol>

          {d.status === "OPEN" ? (
            <ResolveForm disputeId={d.id} amount={formatBDT(d.item.amountMinor)} />
          ) : (
            <div className="rounded-xl border p-4 text-sm">
              <p className="font-medium">{OUTCOME[d.status]}</p>
              {d.resolution && <p className="whitespace-pre-line">{d.resolution}</p>}
              {d.resolvedAt && <p className="text-muted-foreground">{when.format(d.resolvedAt)}</p>}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
