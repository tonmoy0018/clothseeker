import type { Metadata } from "next";

import { ActionForm, SubmitButton } from "@/components/admin/action-form";
import { ProductFields } from "@/components/admin/product-fields";
import { listCategories } from "@/lib/admin/products";
import { requireAdmin } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";

import { createProductAction } from "../actions";

export const metadata: Metadata = { title: "New dress — ClothSeeker admin" };

export default async function NewProductPage() {
  const admin = await requireAdmin();
  const categories = await listCategories(getPrisma(), admin);
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">New dress</h1>
        <p className="text-sm text-muted-foreground">
          New dresses start as drafts. Add sizes, colors and photos, then publish.
        </p>
      </div>
      <ActionForm action={createProductAction} className="flex flex-col gap-4">
        <ProductFields categories={categories} slugOptional />
        <SubmitButton pendingLabel="Creating…" className="self-start">
          Create draft
        </SubmitButton>
      </ActionForm>
    </div>
  );
}
