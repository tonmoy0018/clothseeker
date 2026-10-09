import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { FLAG_TABS, listFlags } from "@/lib/admin/flags";
import { requireAdmin } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { getStorage } from "@/lib/storage/supabase";

import { ReviewForm } from "./review-form";

export const metadata: Metadata = { title: "Logo flags — ClothSeeker admin" };

const when = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Dhaka" });
const JOB_LABEL = { DESIGN_ROUND: "AI design photo", DRESS_MATCH: "Dress photo (start a design)", TRY_ON: "Try-on" } as const;
const STATUS_LABEL = { OPEN: "Open", CONFIRMED: "Confirmed logo", DISMISSED: "Dismissed" } as const;

export default async function AdminFlagsPage({ searchParams }: PageProps<"/admin/flags">) {
  const admin = await requireAdmin();
  const { tab: rawTab } = await searchParams;
  const tab = FLAG_TABS.find((t) => t === rawTab) ?? "open";
  const flags = await listFlags(getPrisma(), getStorage(), admin, tab);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Brand-logo flags</h1>
        <p className="text-sm text-muted-foreground">
          Photos the AI judged to show a clothing brand&apos;s logo. The customer was already told it can&apos;t be used. Confirm to delete the photo, or dismiss a false alarm.
        </p>
      </div>
      <nav className="flex gap-2" aria-label="Flag lists">
        {FLAG_TABS.map((t) => (
          <Link key={t} href={`/admin/flags?tab=${t}`} className={buttonVariants({ variant: tab === t ? "default" : "outline", size: "sm" })} aria-current={tab === t ? "page" : undefined}>
            {t === "open" ? "To review" : "Reviewed"}
          </Link>
        ))}
      </nav>
      {flags.length === 0 ? (
        <p className="rounded-xl border p-8 text-muted-foreground">Nothing here.</p>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2" data-testid="flag-list">
          {flags.map((f) => (
            <li key={f.id} className="flex gap-4 rounded-xl border p-4">
              <span className="relative block h-36 w-28 shrink-0 overflow-hidden rounded-lg bg-muted">
                {f.imageUrl ? <Image src={f.imageUrl} alt="Flagged photo" fill unoptimized className="object-cover" /> : <span className="flex h-full items-center justify-center p-2 text-center text-xs text-muted-foreground">Photo deleted</span>}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={f.status === "OPEN" ? "default" : "secondary"}>{STATUS_LABEL[f.status]}</Badge>
                  {f.jobType && <span className="text-muted-foreground">{JOB_LABEL[f.jobType]}</span>}
                </div>
                <p>{f.reason}</p>
                <p className="text-xs text-muted-foreground">
                  {when.format(f.createdAt)}
                  {f.customerRef ? ` · customer ${f.customerRef}` : ""}
                </p>
                {f.status === "OPEN" ? (
                  <ReviewForm flagId={f.id} />
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Reviewed {f.reviewedAt ? when.format(f.reviewedAt) : ""}
                    {f.reviewNote ? ` — ${f.reviewNote}` : ""}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
