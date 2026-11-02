import { z } from "zod";

import type { PrismaClient } from "@/lib/db/client";
import type { StorageAdapter } from "@/lib/storage/adapter";
import { BUCKETS } from "@/lib/storage/buckets";
import { parseTemplateConfig, templateImageKeys, type TemplateConfig } from "@/types/template";

// Customer-facing template loader, used by the Phase 3 design screen.
// Returns nothing unless the product is ACTIVE (or the viewer's own PRIVATE dress, lib/own-dress) and its
// template is active.

export type CustomerTemplate = {
  productId: string;
  productSlug: string;
  productName: string;
  templateId: string;
  version: number;
  aiEnabled: boolean;
  /** The customer's own dress, made from their photo: ordered only through a quote. */
  ownDress: boolean;
  config: TemplateConfig;
  /** Signed URLs for garment and style reference images, keyed by storage key. */
  imageUrls: Record<string, string>;
};

export async function getCustomizationTemplate(
  db: PrismaClient,
  storage: StorageAdapter,
  rawProductId: unknown,
  options: { signImages?: boolean; viewerId?: string | null } = {},
): Promise<CustomerTemplate | null> {
  const productId = z.uuid().safeParse(rawProductId);
  if (!productId.success) {
    return null;
  }
  const product = await db.product.findFirst({
    where: {
      id: productId.data,
      template: { isActive: true },
      // A customer's own dress only for that customer.
      OR: [{ status: "ACTIVE" }, ...(options.viewerId ? [{ status: "PRIVATE" as const, ownerId: options.viewerId }] : [])],
    },
    select: {
      id: true,
      status: true,
      slug: true,
      name: true,
      template: { select: { id: true, version: true, aiEnabled: true, config: true } },
    },
  });
  if (!product?.template) {
    return null;
  }
  const config = parseTemplateConfig(product.template.config);
  const urls =
    options.signImages === false ? new Map<string, string>() : await storage.signReadUrls(BUCKETS.productMedia, templateImageKeys(config));
  return {
    productId: product.id,
    productSlug: product.slug,
    productName: product.name,
    templateId: product.template.id,
    version: product.template.version,
    aiEnabled: product.template.aiEnabled,
    ownDress: product.status === "PRIVATE",
    config,
    imageUrls: Object.fromEntries(urls),
  };
}
