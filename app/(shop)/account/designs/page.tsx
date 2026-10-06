import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { listDesigns } from "@/lib/design/service";
import { formatBDT } from "@/lib/money";
import { BUCKETS } from "@/lib/storage/buckets";
import { getStorage } from "@/lib/storage/supabase";

import { DeleteDesignButton } from "./delete-button";

export const metadata: Metadata = { title: "My designs — ClothSeeker" };

const dateFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "Asia/Dhaka" });

export default async function MyDesignsPage() {
  const user = await requireUser("/account/designs");
  const storage = getStorage();
  const designs = user.role === "CUSTOMER" ? await listDesigns(getPrisma(), storage, user) : [];
  const previews = await storage.signReadUrls(
    BUCKETS.designAssets,
    designs.flatMap((d) => (d.previewKey ? [d.previewKey] : [])),
  );

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">My designs</h1>
      {designs.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-xl border p-8">
          <p className="font-medium">You haven&apos;t saved any designs yet.</p>
          <p className="text-sm text-muted-foreground">Look for dresses marked “Customizable” and make one your own.</p>
          <Link href="/products" className={buttonVariants()}>
            Browse dresses
          </Link>
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4" data-testid="design-list">
          {designs.map((d) => {
            const preview = d.previewKey ? previews.get(d.previewKey) : undefined;
            return (
              <li key={d.id} className="flex flex-col gap-2">
                <Link href={`/customize/${d.productId}?design=${d.id}`} className="group flex flex-col gap-2">
                  <div className="relative aspect-[1200/1560] overflow-hidden rounded-xl bg-muted">
                    {preview && <Image src={preview} alt={`Your ${d.productName} design`} fill unoptimized className="object-contain" />}
                  </div>
                  <span className="font-medium group-hover:underline">{d.productName}</span>
                </Link>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-muted-foreground">
                    {d.check.price ? formatBDT(d.check.price.totalMinor) : d.check.issue} · Saved {dateFormat.format(d.updatedAt)}
                  </span>
                  <DeleteDesignButton designId={d.id} label={d.productName} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
