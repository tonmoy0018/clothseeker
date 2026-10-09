import { z } from "zod";

import { assertAdmin, type Actor } from "@/lib/auth/policy";
import type { PrismaClient } from "@/lib/db/client";
import type { Prisma } from "@/lib/generated/prisma/client";

// Read-only audit log for /admin/audit. Metadata holds ids, counts and statuses only (written by
// writeAudit and the system sweeps), so it can be shown as is.

export const AUDIT_PAGE_SIZE = 50;

export const auditFiltersSchema = z.object({
  action: z
    .string()
    .trim()
    .max(60)
    .regex(/^[a-z_.]*$/)
    .optional()
    .catch(undefined),
  target: z
    .string()
    .trim()
    .max(40)
    .regex(/^[a-z_]*$/)
    .optional()
    .catch(undefined),
  actor: z.enum(["any", "admin", "customer", "system"]).catch("any"),
  from: z.iso.date().optional().catch(undefined),
  to: z.iso.date().optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(1000).catch(1),
});
export type AuditFilters = z.infer<typeof auditFiltersSchema>;

export type AuditRow = {
  id: string;
  createdAt: Date;
  action: string;
  targetType: string;
  targetId: string | null;
  actor: { kind: "system" } | { kind: "admin" | "customer" | "unknown"; label: string };
  metadata: [string, string][];
};

/** Admins are named (they're the team); customers are only "Customer". A deleted account says so. */
function describeActor(actor: { role: string; name: string | null; email: string } | null, role: string | null): AuditRow["actor"] {
  if (actor) {
    return actor.role === "ADMIN" ? { kind: "admin", label: actor.name ?? actor.email } : { kind: "customer", label: "Customer" };
  }
  switch (role) {
    case "SYSTEM":
      return { kind: "system" };
    case "ADMIN":
      return { kind: "admin", label: "Team member (account removed)" };
    case "CUSTOMER":
      return { kind: "customer", label: "Customer (account deleted)" };
    default:
      return { kind: "unknown", label: "Unknown" };
  }
}

/** Dhaka date (YYYY-MM-DD) → the UTC instant that day starts. */
function dhakaDayStart(date: string): Date {
  return new Date(`${date}T00:00:00+06:00`);
}

function metadataPairs(value: unknown): [string, string][] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)]);
}

export async function listAuditLog(db: PrismaClient, actor: Actor, rawFilters: unknown): Promise<{ rows: AuditRow[]; hasMore: boolean; filters: AuditFilters }> {
  assertAdmin(actor);
  const filters = auditFiltersSchema.parse(rawFilters ?? {});
  const where: Prisma.AuditLogWhereInput = {
    ...(filters.action ? { action: { startsWith: filters.action } } : {}),
    ...(filters.target ? { targetType: filters.target } : {}),
    ...(filters.actor === "system" ? { actorId: null, OR: [{ actorRole: "SYSTEM" }, { actorRole: null }] } : {}),
    ...(filters.actor === "admin" ? { OR: [{ actor: { role: "ADMIN" } }, { actorRole: "ADMIN" }] } : {}),
    ...(filters.actor === "customer" ? { OR: [{ actor: { role: "CUSTOMER" } }, { actorRole: "CUSTOMER" }] } : {}),
    ...(filters.from || filters.to
      ? {
          createdAt: {
            ...(filters.from ? { gte: dhakaDayStart(filters.from) } : {}),
            ...(filters.to ? { lt: new Date(dhakaDayStart(filters.to).getTime() + 24 * 60 * 60 * 1000) } : {}),
          },
        }
      : {}),
  };
  const rows = await db.auditLog.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: (filters.page - 1) * AUDIT_PAGE_SIZE,
    take: AUDIT_PAGE_SIZE + 1,
    select: { id: true, createdAt: true, action: true, targetType: true, targetId: true, metadata: true, actorRole: true, actor: { select: { role: true, name: true, email: true } } },
  });
  return {
    hasMore: rows.length > AUDIT_PAGE_SIZE,
    filters,
    rows: rows.slice(0, AUDIT_PAGE_SIZE).map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      actor: describeActor(r.actor, r.actorRole),
      metadata: metadataPairs(r.metadata),
    })),
  };
}

/** Where a target links to in the admin, if anywhere. */
export function auditTargetHref(targetType: string, targetId: string | null, metadata: [string, string][]): string | null {
  if (!targetId) return null;
  const meta = Object.fromEntries(metadata);
  switch (targetType) {
    case "product":
      return `/admin/products/${targetId}`;
    case "template":
      return null;
    case "order_item":
      return meta.orderId ? `/admin/orders/${meta.orderId}#item-${targetId}` : null;
    case "quote_request":
      return `/admin/quotes/${targetId}`;
    case "dispute":
      return `/admin/disputes/${targetId}`;
    case "flagged_item":
      return "/admin/flags?tab=closed";
    default:
      return null;
  }
}
