import type { PrismaClient } from "@/lib/db/client";
import { parseTemplateConfig } from "@/types/template";

// Which image stands in for a ready-made dress in a try-on: its first product photo, or else the
// flat garment image of its live customization template. Null when there is neither.

export async function productTryOnImageKey(db: Pick<PrismaClient, "product">, productId: string): Promise<string | null> {
  const product = await db.product.findFirst({
    where: { id: productId, status: "ACTIVE" },
    select: { imageKeys: true, template: { select: { isActive: true, config: true } } },
  });
  if (!product) {
    return null;
  }
  const photo = product.imageKeys[0];
  if (photo) {
    return photo;
  }
  if (product.template?.isActive) {
    try {
      return parseTemplateConfig(product.template.config).garmentImages.front ?? null;
    } catch {
      return null;
    }
  }
  return null;
}
