import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { getTemplateForEdit } from "@/lib/admin/templates";
import { requireAdmin } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { getStorage } from "@/lib/storage/supabase";

import { TemplateEditor } from "./template-editor";

export const metadata: Metadata = { title: "Template editor — ClothSeeker admin" };

export default async function TemplatePage({ params }: PageProps<"/admin/products/[id]/template">) {
  const admin = await requireAdmin();
  const { id } = await params;
  const template = await getTemplateForEdit(getPrisma(), getStorage(), admin, id);
  if (!template) {
    notFound();
  }
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link href={`/admin/products/${template.productId}`} className="text-sm text-muted-foreground hover:text-foreground">
          ← {template.productName}
        </Link>
        <h1 className="text-2xl font-semibold">Customization template</h1>
        <p className="text-sm text-muted-foreground">
          Define what customers can change. Changes take effect for new designs when you save.
        </p>
      </div>
      <TemplateEditor
        productId={template.productId}
        initialVersion={template.version}
        initialActive={template.isActive}
        initialAiEnabled={template.aiEnabled}
        initialConfig={template.config}
        initialImageUrls={template.imageUrls}
      />
    </div>
  );
}
