import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ActionForm, SubmitButton } from "@/components/admin/action-form";
import { PhotoUploadForm } from "@/components/admin/photo-upload-form";
import { ProductFields } from "@/components/admin/product-fields";
import { StatusBadge } from "@/components/admin/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MAX_PRODUCT_PHOTOS } from "@/lib/admin/media";
import { getAdminProduct, listCategories } from "@/lib/admin/products";
import { requireAdmin } from "@/lib/auth/guards";
import { SIZE_ORDER } from "@/lib/catalog/size-chart";
import { getPrisma } from "@/lib/db";
import { MINOR_PER_MAJOR } from "@/lib/money";
import { BUCKETS } from "@/lib/storage/buckets";
import { getStorage } from "@/lib/storage/supabase";

import {
  addVariantAction,
  createTemplateAction,
  removePhotoAction,
  setCoverPhotoAction,
  setProductStatusAction,
  updateProductAction,
  updateVariantAction,
  uploadPhotoAction,
} from "../actions";

export const metadata: Metadata = { title: "Edit dress — ClothSeeker admin" };

const selectClass = "h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm";

export default async function AdminProductPage({ params }: PageProps<"/admin/products/[id]">) {
  const admin = await requireAdmin();
  const { id } = await params;
  const db = getPrisma();
  const [product, categories] = await Promise.all([getAdminProduct(db, admin, id), listCategories(db, admin)]);
  if (!product) {
    notFound();
  }
  const photoUrls = await getStorage().signReadUrls(BUCKETS.productMedia, product.imageKeys);
  const toTaka = (minor: number) => String(minor / MINOR_PER_MAJOR);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Link href="/admin/products" className="text-sm text-muted-foreground hover:text-foreground">
            ← Products
          </Link>
          <h1 className="flex items-center gap-3 text-2xl font-semibold">
            {product.name} <StatusBadge status={product.status} />
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {product.status === "ACTIVE" && (
            <Link href={`/products/${product.slug}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
              View in shop
            </Link>
          )}
          <ActionForm action={setProductStatusAction} className="flex flex-wrap items-center gap-2" messageClassName="w-full">
            <input type="hidden" name="id" value={product.id} />
            {product.status !== "ACTIVE" && (
              <SubmitButton name="status" value="ACTIVE" size="sm" pendingLabel="Publishing…">
                Publish
              </SubmitButton>
            )}
            {product.status === "ACTIVE" && (
              <SubmitButton name="status" value="DRAFT" size="sm" variant="outline" pendingLabel="Updating…">
                Unpublish
              </SubmitButton>
            )}
            {product.status !== "ARCHIVED" && (
              <SubmitButton name="status" value="ARCHIVED" size="sm" variant="ghost" pendingLabel="Archiving…">
                Archive
              </SubmitButton>
            )}
          </ActionForm>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <ActionForm action={updateProductAction} className="flex flex-col gap-4">
            <input type="hidden" name="id" value={product.id} />
            <ProductFields
              categories={categories}
              defaults={{
                name: product.name,
                slug: product.slug,
                categoryId: product.categoryId,
                description: product.description,
              }}
            />
            <SubmitButton className="self-start">Save details</SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sizes and colors</CardTitle>
          <CardDescription>
            Prices are in taka. Turn a row off to hide it from the shop; rows are never deleted so past orders stay intact.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {product.variants.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sizes or colors yet. Add the first one below.</p>
          ) : (
            <div className="flex flex-col divide-y rounded-lg border" data-testid="variant-rows">
              {product.variants.map((v) => (
                <ActionForm
                  key={v.id}
                  action={updateVariantAction}
                  className="grid grid-cols-2 items-center gap-3 p-3 text-sm sm:grid-cols-[1.5fr_1fr_1fr_auto_auto]"
                  messageClassName="col-span-full"
                >
                  <input type="hidden" name="variantId" value={v.id} />
                  <input type="hidden" name="productId" value={product.id} />
                  <div className="col-span-2 flex items-center gap-2 sm:col-span-1">
                    <span className="size-4 shrink-0 rounded-full ring-1 ring-black/15" style={{ backgroundColor: v.colorHex }} />
                    <span className="font-medium">
                      {v.size} · {v.colorName}
                    </span>
                    <span className="hidden text-xs text-muted-foreground lg:inline">{v.sku}</span>
                  </div>
                  <label className="flex items-center gap-1">
                    <span className="text-muted-foreground">৳</span>
                    <Input name="priceTaka" type="number" min="0.01" step="0.01" defaultValue={toTaka(v.priceMinor)} aria-label={`Price for ${v.size} ${v.colorName}`} />
                  </label>
                  <label className="flex items-center gap-1">
                    <span className="text-muted-foreground">Stock</span>
                    <Input name="stock" type="number" min="0" step="1" defaultValue={v.stock} aria-label={`Stock for ${v.size} ${v.colorName}`} />
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" name="isActive" defaultChecked={v.isActive} className="size-4" />
                    Active
                  </label>
                  <SubmitButton size="sm" variant="outline">
                    Save
                  </SubmitButton>
                </ActionForm>
              ))}
            </div>
          )}

          <ActionForm
            action={addVariantAction}
            className="grid grid-cols-2 items-end gap-3 rounded-lg bg-muted/40 p-3 text-sm sm:grid-cols-[auto_1.2fr_auto_1fr_1fr_auto]"
            messageClassName="col-span-full"
          >
            <input type="hidden" name="productId" value={product.id} />
            <label className="flex flex-col gap-1">
              <span>Size</span>
              <select name="size" required defaultValue="" className={selectClass}>
                <option value="" disabled>
                  Size
                </option>
                {SIZE_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span>Color name</span>
              <Input name="colorName" required maxLength={30} placeholder="e.g. Sage" />
            </label>
            <label className="flex flex-col gap-1">
              <span>Swatch</span>
              <input name="colorHex" type="color" defaultValue="#9caf88" className="h-8 w-12 rounded border" />
            </label>
            <label className="flex flex-col gap-1">
              <span>Price (৳)</span>
              <Input name="priceTaka" type="number" min="0.01" step="0.01" required />
            </label>
            <label className="flex flex-col gap-1">
              <span>Stock</span>
              <Input name="stock" type="number" min="0" step="1" required defaultValue={0} />
            </label>
            <SubmitButton pendingLabel="Adding…">Add</SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Photos</CardTitle>
          <CardDescription>
            The first photo is the cover in the shop. Up to {MAX_PRODUCT_PHOTOS} photos. Images are checked, resized and stripped of
            location data automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {product.imageKeys.length > 0 && (
            <ul className="grid grid-cols-2 gap-4 sm:grid-cols-4" data-testid="photo-grid">
              {product.imageKeys.map((key, index) => {
                const url = photoUrls.get(key);
                return (
                  <li key={key} className="flex flex-col gap-2">
                    <div className="relative aspect-[4/5] overflow-hidden rounded-lg bg-muted">
                      {url && <Image src={url} alt={`Photo ${index + 1}`} fill unoptimized className="object-cover" />}
                      {index === 0 && (
                        <span className="absolute top-2 left-2 rounded bg-background/90 px-1.5 py-0.5 text-xs">Cover</span>
                      )}
                    </div>
                    <div className="flex gap-1">
                      {index > 0 && (
                        <ActionForm action={setCoverPhotoAction}>
                          <input type="hidden" name="productId" value={product.id} />
                          <input type="hidden" name="key" value={key} />
                          <SubmitButton size="xs" variant="outline" pendingLabel="…">
                            Make cover
                          </SubmitButton>
                        </ActionForm>
                      )}
                      <ActionForm action={removePhotoAction}>
                        <input type="hidden" name="productId" value={product.id} />
                        <input type="hidden" name="key" value={key} />
                        <SubmitButton size="xs" variant="ghost" pendingLabel="…">
                          Remove
                        </SubmitButton>
                      </ActionForm>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {product.imageKeys.length < MAX_PRODUCT_PHOTOS && (
            <PhotoUploadForm action={uploadPhotoAction} hidden={{ productId: product.id }} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Customization</CardTitle>
          <CardDescription>
            Let customers design their own version of this dress: colors per part, text, images and style options.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          {product.template ? (
            <>
              <span className="text-sm">
                Template v{product.template.version} · {product.template.isActive ? "Live" : "Not live yet"} · AI design{" "}
                {product.template.aiEnabled ? "on" : "off"}
              </span>
              <Link href={`/admin/products/${product.id}/template`} className={buttonVariants({ variant: "outline" })}>
                Edit template
              </Link>
            </>
          ) : (
            <ActionForm action={createTemplateAction}>
              <input type="hidden" name="productId" value={product.id} />
              <SubmitButton variant="outline" pendingLabel="Creating…">
                Enable customization
              </SubmitButton>
            </ActionForm>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
