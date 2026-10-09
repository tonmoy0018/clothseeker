import type { PrismaClient } from "@/lib/db/client";
import type { AiLimitFeature } from "@/lib/generated/prisma/enums";

/**
 * Records that a customer was refused by a daily limit (shown on /admin/ai). Called after the
 * refused transaction has rolled back, and never fails the request it describes.
 */
export async function recordLimitHit(db: PrismaClient, customerId: string, feature: AiLimitFeature): Promise<void> {
  await db.aiLimitHit.create({ data: { customerId, feature } }).catch(() => undefined);
}
