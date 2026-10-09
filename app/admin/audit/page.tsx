import type { Metadata } from "next";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { auditTargetHref, listAuditLog } from "@/lib/admin/audit-log";
import { requireAdmin } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";

export const metadata: Metadata = { title: "Audit log — ClothSeeker admin" };

const when = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "medium", timeZone: "Asia/Dhaka" });
const field = "h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm";

export default async function AdminAuditPage({ searchParams }: PageProps<"/admin/audit">) {
  const admin = await requireAdmin();
  const params = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
  const { rows, hasMore, filters } = await listAuditLog(getPrisma(), admin, {
    action: first(params.action),
    target: first(params.target),
    actor: first(params.actor),
    from: first(params.from),
    to: first(params.to),
    page: first(params.page),
  });
  const pageHref = (page: number) => {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries({ action: filters.action, target: filters.target, actor: filters.actor === "any" ? undefined : filters.actor, from: filters.from, to: filters.to })) {
      if (v) query.set(k, v);
    }
    query.set("page", String(page));
    return `/admin/audit?${query.toString()}`;
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Audit log</h1>
        <p className="text-sm text-muted-foreground">Every sensitive action, who did it and when. Details hold ids, counts and statuses only.</p>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-2 text-sm" aria-label="Filter the audit log">
        <label className="flex flex-col gap-1">
          Action starts with
          <Input name="action" defaultValue={filters.action} placeholder="e.g. quote." className="w-40" />
        </label>
        <label className="flex flex-col gap-1">
          Target
          <select name="target" defaultValue={filters.target ?? ""} className={field}>
            <option value="">Any</option>
            {["order_item", "product", "template", "quote_request", "dispute", "flagged_item", "try_on_photo", "try_on_media"].map((t) => (
              <option key={t} value={t}>
                {t.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Who
          <select name="actor" defaultValue={filters.actor} className={field}>
            <option value="any">Anyone</option>
            <option value="admin">Team</option>
            <option value="customer">Customers</option>
            <option value="system">System</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          From
          <input type="date" name="from" defaultValue={filters.from} className={field} />
        </label>
        <label className="flex flex-col gap-1">
          To
          <input type="date" name="to" defaultValue={filters.to} className={field} />
        </label>
        <button type="submit" className={buttonVariants({ variant: "outline", size: "sm" })}>
          Filter
        </button>
      </form>

      {rows.length === 0 ? (
        <p className="rounded-xl border p-8 text-muted-foreground">No entries.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm" data-testid="audit-table">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="p-2 font-medium">When</th>
                <th className="p-2 font-medium">Who</th>
                <th className="p-2 font-medium">Action</th>
                <th className="p-2 font-medium">Target</th>
                <th className="p-2 font-medium">Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const href = auditTargetHref(r.targetType, r.targetId, r.metadata);
                return (
                  <tr key={r.id} className="border-b align-top last:border-0">
                    <td className="p-2 whitespace-nowrap">{when.format(r.createdAt)}</td>
                    <td className="p-2 whitespace-nowrap">{r.actor.kind === "system" ? "System" : r.actor.label}</td>
                    <td className="p-2 font-mono text-xs whitespace-nowrap">{r.action}</td>
                    <td className="p-2 whitespace-nowrap">
                      {href ? (
                        <Link href={href} className="underline underline-offset-4">
                          {r.targetType.replaceAll("_", " ")}
                        </Link>
                      ) : (
                        r.targetType.replaceAll("_", " ")
                      )}
                    </td>
                    <td className="p-2 text-xs text-muted-foreground">{r.metadata.map(([k, v]) => `${k}: ${v}`).join(" · ")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex gap-2">
        {filters.page > 1 && (
          <Link href={pageHref(filters.page - 1)} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Newer
          </Link>
        )}
        {hasMore && (
          <Link href={pageHref(filters.page + 1)} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Older
          </Link>
        )}
      </div>
    </div>
  );
}
