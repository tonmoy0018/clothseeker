import { z } from "zod";

import type { PrismaClient } from "@/lib/db/client";
import type { StorageAdapter } from "@/lib/storage/adapter";
import { BUCKETS } from "@/lib/storage/buckets";
import { parseTemplateConfig, templateImageKeys, type TemplateConfig } from "@/types/template";

// Customer-facing template loader, used by the Phase 3 design screen.
// Returns nothing unless the product is ACTIVE and its template is active.

export type CustomerTemplate = {
  productId: string;
  productSlug: string;
  productName: string;
  templateId: string;
  version: number;
  aiEnabled: boolean;
  config: TemplateConfig;
  /** Signed URLs for garment and style reference images, keyed by storage key. */
  imageUrls: Record<string, string>;
};

export async function getCustomizationTemplate(
  db: PrismaClient,
  storage: StorageAdapter,
  rawProductId: unknown,
  options: { signImages?: boolean } = {},
): Promise<CustomerTemplate | null> {
  const productId = z.uuid().safeParse(rawProductId);
  if (!productId.success) {
    return null;
  }
  const product = await db.product.findFirst({
    where: { id: productId.data, status: "ACTIVE", template: { isActive: true } },
    select: {
      id: true,
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
    config,
    imageUrls: Object.fromEntries(urls),
  };
}
