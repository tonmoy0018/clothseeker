import type { Metadata } from "next";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db";
import { getDesignForEdit, loadDesignContext } from "@/lib/design/service";
import { getStorage } from "@/lib/storage/supabase";

import { EditorLoader } from "./editor-loader";

export const metadata: Metadata = { title: "Design your dress — ClothSeeker" };

export default async function CustomizePage({ params, searchParams }: PageProps<"/customize/[productId]">) {
  const { productId } = await params;
  const { design } = await searchParams;
  const db = getPrisma();
  const storage = getStorage();
  const context = await loadDesignContext(db, storage, productId);

  if (!context) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-xl border p-8" data-testid="not-customizable">
        <h1 className="text-xl font-semibold">This dress can&apos;t be customized</h1>
        <p className="text-muted-foreground">It may not offer custom designs, or it&apos;s temporarily unavailable.</p>
        <Link href="/products" className={buttonVariants({ variant: "outline" })}>
          Browse dresses
        </Link>
      </div>
    );
  }

  const user = await getCurrentUser();
  const customer = user?.role === "CUSTOMER" ? user : null;
  // Only the signed-in customer's own design is ever loaded; anything else starts a fresh design.
  const initialDesign =
    customer && typeof design === "string" ? await getDesignForEdit(db, storage, customer, design, context.template.productId) : null;

  return (
    <EditorLoader
      productId={context.template.productId}
      productName={context.template.productName}
      templateId={context.template.templateId}
      templateVersion={context.template.version}
      aiEnabled={context.template.aiEnabled}
      config={context.template.config}
      imageUrls={context.template.imageUrls}
      availableSizes={context.availableSizes}
      basePrices={context.basePrices}
      customerId={customer?.id ?? null}
      initialDesign={initialDesign}
    />
  );
}
