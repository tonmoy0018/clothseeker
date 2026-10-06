import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { StatusBadge } from "@/components/admin/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { listAdminProducts, listCategories } from "@/lib/admin/products";
import { requireAdmin } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { BUCKETS } from "@/lib/storage/buckets";
import { getStorage } from "@/lib/storage/supabase";

export const metadata: Metadata = { title: "Products — ClothSeeker admin" };

const selectClass = "h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm";

export default async function AdminProductsPage({ searchParams }: PageProps<"/admin/products">) {
  const admin = await requireAdmin();
  const params = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
  const filters = { status: first(params.status), categoryId: first(params.categoryId), q: first(params.q) };
  const db = getPrisma();
  const [products, categories] = await Promise.all([listAdminProducts(db, admin, filters), listCategories(db, admin)]);
  const covers = await getStorage().signReadUrls(
    BUCKETS.productMedia,
    products.flatMap((p) => (p.coverKey ? [p.coverKey] : [])),
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Products</h1>
        <Link href="/admin/products/new" className={buttonVariants()}>
          New dress
        </Link>
      </div>

      <form method="get" className="flex flex-wrap items-center gap-2" aria-label="Filter products">
        <Input name="q" placeholder="Search name or slug" defaultValue={filters.q} className="w-56" />
        <select name="status" defaultValue={filters.status ?? ""} className={selectClass} aria-label="Status">
          <option value="">All statuses</option>
          <option value="ACTIVE">Live</option>
          <option value="DRAFT">Draft</option>
          <option value="ARCHIVED">Archived</option>
        </select>
        <select name="categoryId" defaultValue={filters.categoryId ?? ""} className={selectClass} aria-label="Category">
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button type="submit" className={buttonVariants({ variant: "outline", size: "sm" })}>
          Filter
        </button>
      </form>

      {products.length === 0 ? (
        <p className="rounded-xl border p-8 text-muted-foreground">No dresses match. Try clearing the filters.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">Dress</th>
                <th className="p-3 font-medium">Status</th>
                <th className="p-3 font-medium">Category</th>
                <th className="p-3 text-right font-medium">Sizes/colors</th>
                <th className="p-3 text-right font-medium">Stock</th>
                <th className="p-3 font-medium">Photos</th>
                <th className="p-3 font-medium">Customizable</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {products.map((p) => {
                const cover = p.coverKey ? covers.get(p.coverKey) : undefined;
                return (
                  <tr key={p.id} className="hover:bg-muted/30">
                    <td className="p-3">
                      <Link href={`/admin/products/${p.id}`} className="flex items-center gap-3 font-medium hover:underline">
                        {cover ? (
                          <Image src={cover} alt="" width={40} height={50} unoptimized className="h-12 w-10 rounded object-cover" />
                        ) : (
                          <span className="h-12 w-10 rounded bg-muted" aria-hidden />
                        )}
                        <span>
                          {p.name}
                          <span className="block text-xs font-normal text-muted-foreground">{p.slug}</span>
                        </span>
                      </Link>
                    </td>
                    <td className="p-3">
                      <StatusBadge status={p.status} />
                    </td>
                    <td className="p-3">{p.categoryName}</td>
                    <td className="p-3 text-right tabular-nums">
                      {p.activeVariantCount}/{p.variantCount}
                    </td>
                    <td className="p-3 text-right tabular-nums">{p.totalStock}</td>
                    <td className="p-3 tabular-nums">{p.photoCount}</td>
                    <td className="p-3">{p.template ? (p.template.isActive ? "Yes (live)" : "Draft template") : "—"}</td>
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
