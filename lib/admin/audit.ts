import type { Actor } from "@/lib/auth/policy";
import type { Prisma } from "@/lib/generated/prisma/client";

// Audit trail for sensitive admin actions. Metadata must never contain secrets or personal data:
// use ids, field names, statuses and counts only.

export type AuditMetadata = Record<string, string | number | boolean | null | string[]>;

export async function writeAudit(
  tx: Prisma.TransactionClient,
  actor: Actor,
  action: string,
  target: { type: string; id: string | null },
  metadata: AuditMetadata = {},
): Promise<void> {
  await tx.auditLog.create({
    data: { actorId: actor.id, action, targetType: target.type, targetId: target.id, metadata },
  });
}

/** Names of fields whose values differ — what goes into audit metadata instead of the values. */
export function changedFields<T extends Record<string, unknown>>(before: T, after: Partial<T>): string[] {
  return Object.keys(after).filter((key) => after[key] !== undefined && after[key] !== before[key]);
}
