import { z } from "zod";

import type { PrismaClient } from "@/lib/db/client";
import type { NotificationKind } from "@/lib/generated/prisma/enums";
import { formatBDT } from "@/lib/money";

import type { EmailProvider } from "./providers";
import { renderEmail, type EmailData } from "./templates";

// Worker sweep: sends queued emails. Each email is claimed with a guarded update (QUEUED → SENDING),
// so two workers never send the same one. It's rendered from CURRENT data (names, tracking numbers),
// retried with backoff, and FAILED after MAX_ATTEMPTS. Logs carry ids and kinds only.

export const MAX_EMAIL_ATTEMPTS = 3;
const BATCH = 20;
const STUCK_AFTER_MS = 10 * 60 * 1000;
const backoffMs = (attempt: number) => 60_000 * 4 ** Math.max(0, attempt - 1);

export type SenderOptions = {
  provider: EmailProvider;
  appUrl: string;
  from: string;
  now?: Date;
  log?: (msg: string, fields: Record<string, string | number | boolean | null | undefined>) => void;
};

const payloadSchema = z.object({ orderId: z.uuid().optional(), itemIds: z.array(z.uuid()).optional(), quoteId: z.uuid().optional() });

class MissingData extends Error {
  override readonly name = "MissingData";
}

function firstName(name: string | null): string | null {
  return name?.trim().split(/\s+/)[0] ?? null;
}

async function emailData(db: PrismaClient, kind: NotificationKind, rawPayload: unknown, appUrl: string): Promise<Omit<EmailData, "firstName">> {
  const payload = payloadSchema.parse(rawPayload);
  if (payload.quoteId) {
    const quote = await db.quoteRequest.findUnique({
      where: { id: payload.quoteId },
      select: { id: true, priceMinor: true, responseNote: true, design: { select: { product: { select: { name: true } } } } },
    });
    if (!quote) throw new MissingData();
    return {
      link: `${appUrl}/account/quotes/${quote.id}`,
      productName: quote.design.product.name,
      price: quote.priceMinor !== null ? formatBDT(quote.priceMinor) : undefined,
      note: quote.responseNote,
      hadPrice: quote.priceMinor !== null,
    };
  }
  if (!payload.orderId) throw new MissingData();
  const order = await db.order.findUnique({
    where: { id: payload.orderId },
    select: {
      id: true,
      number: true,
      items: {
        where: payload.itemIds ? { id: { in: payload.itemIds } } : {},
        select: {
          id: true,
          productName: true,
          shipment: { select: { trackingNumber: true } },
          refunds: { where: { kind: "ITEM" }, select: { reason: true }, take: 1 },
          disputes: { orderBy: { createdAt: "desc" }, select: { resolution: true }, take: 1 },
        },
      },
    },
  });
  if (!order) throw new MissingData();
  const first = order.items[0];
  const note =
    kind === "DISPUTE_REFUNDED" || kind === "DISPUTE_CLOSED"
      ? (first?.disputes[0]?.resolution ?? null)
      : kind === "ITEM_REFUNDED"
        ? (first?.refunds[0]?.reason.replace(/^Declined by ClothSeeker: /, "") ?? null)
        : null;
  return {
    link: `${appUrl}/account/orders/${order.id}`,
    orderNumber: order.number,
    items: order.items.map((i) => i.productName),
    trackingNumbers: order.items.flatMap((i) => (i.shipment?.trackingNumber ? [i.shipment.trackingNumber] : [])),
    note,
  };
}

/** Sends up to one batch of due emails. Returns how many were sent. */
export async function sendQueuedEmails(db: PrismaClient, options: SenderOptions): Promise<number> {
  const now = options.now ?? new Date();
  // A worker that died mid-send leaves SENDING rows behind: give them another go.
  await db.notification.updateMany({ where: { status: "SENDING", lockedAt: { lt: new Date(now.getTime() - STUCK_AFTER_MS) } }, data: { status: "QUEUED", lockedAt: null } });

  const due = await db.notification.findMany({
    where: { status: "QUEUED", runAfter: { lte: now } },
    orderBy: { createdAt: "asc" },
    take: BATCH,
    select: { id: true },
  });
  let sent = 0;
  for (const { id } of due) {
    const claimed = await db.notification.updateMany({ where: { id, status: "QUEUED" }, data: { status: "SENDING", lockedAt: now, attempts: { increment: 1 } } });
    if (claimed.count !== 1) continue; // another worker took it
    const n = await db.notification.findUniqueOrThrow({
      where: { id },
      select: { id: true, kind: true, payload: true, attempts: true, customer: { select: { email: true, name: true } } },
    });
    try {
      const data = await emailData(db, n.kind, n.payload, options.appUrl);
      const email = renderEmail(n.kind, { ...data, firstName: firstName(n.customer.name) });
      await options.provider.send({ to: n.customer.email, from: options.from, ...email });
      await db.notification.update({ where: { id }, data: { status: "SENT", sentAt: now, lockedAt: null, error: null } });
      sent++;
      options.log?.("email.sent", { id, kind: n.kind });
    } catch (error) {
      const name = error instanceof Error ? error.name : "UnknownError";
      const permanent = error instanceof MissingData || error instanceof z.ZodError;
      const retry = !permanent && n.attempts < MAX_EMAIL_ATTEMPTS;
      await db.notification.update({
        where: { id },
        data: retry
          ? { status: "QUEUED", lockedAt: null, runAfter: new Date(now.getTime() + backoffMs(n.attempts)), error: name }
          : { status: "FAILED", lockedAt: null, error: name },
      });
      options.log?.(retry ? "email.retry" : "email.failed", { id, kind: n.kind, attempt: n.attempts, error: name });
    }
  }
  return sent;
}
