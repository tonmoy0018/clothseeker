import type { PrismaClient } from "@/lib/db/client";
import { Prisma } from "@/lib/generated/prisma/client";
import { notify } from "@/lib/notifications/outbox";
import type { PaymentProvider } from "@/lib/payments/types";
import type { StorageAdapter } from "@/lib/storage/adapter";

import { cancelPendingOrder, removeOrderFiles } from "./cancel";
import { PaymentWebhookError } from "./errors";
import { transitionItems } from "./transitions";

// Payment webhooks. Gateways retry and may deliver the same event more than once, in any order:
// every path here is idempotent. Signature checks happen in the provider (parseWebhook).

export const ACCEPTANCE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type WebhookOutcome = "paid" | "failed" | "refunded" | "duplicate" | "ignored";

const SYSTEM = { type: "SYSTEM" as const, id: null };

export async function handlePaymentWebhook(
  db: PrismaClient,
  provider: PaymentProvider,
  storage: StorageAdapter | undefined,
  rawBody: string,
  headers: Headers,
  now: Date = new Date(),
): Promise<WebhookOutcome> {
  const event = provider.parseWebhook(rawBody, headers);

  const payment = await db.payment.findUnique({
    where: { providerRef: event.providerRef },
    select: { id: true, orderId: true, amountMinor: true, currency: true },
  });
  if (!payment) {
    throw new PaymentWebhookError("UNKNOWN_PAYMENT", "No payment with that reference");
  }
  if (payment.amountMinor !== event.amountMinor || payment.currency !== event.currency) {
    throw new PaymentWebhookError("AMOUNT_MISMATCH", "Event amount doesn't match the payment");
  }

  let outcome: WebhookOutcome;
  let filesToRemove: string[] = [];
  try {
    outcome = await db.$transaction(async (tx) => {
      // Each event is processed at most once.
      if (await tx.paymentEvent.findUnique({ where: { eventId: event.eventId }, select: { id: true } })) {
        return "duplicate";
      }
      await tx.paymentEvent.create({ data: { eventId: event.eventId, paymentId: payment.id, type: event.type } });

      if (event.type === "payment.failed") {
        const failed = await tx.payment.updateMany({ where: { id: payment.id, status: "PENDING" }, data: { status: "FAILED" } });
        if (failed.count === 0) {
          return "ignored";
        }
        const result = await cancelPendingOrder(tx, payment.orderId, SYSTEM, "Payment was declined");
        filesToRemove = result.fileKeys;
        return "failed";
      }

      // payment.succeeded
      const succeeded = await tx.payment.updateMany({
        where: { id: payment.id, status: { in: ["PENDING", "FAILED"] } },
        data: { status: "SUCCEEDED" },
      });
      if (succeeded.count === 0) {
        return "ignored"; // already succeeded (or refunded) — a different event for the same payment
      }
      const paid = await tx.order.updateMany({
        where: { id: payment.orderId, status: "PENDING_PAYMENT" },
        data: { status: "PAID", paidAt: now },
      });
      if (paid.count === 0) {
        // The order was cancelled (expired or declined) before the money arrived: give it back.
        await tx.payment.update({ where: { id: payment.id }, data: { status: "REFUNDED" } });
        await tx.orderEvent.create({
          data: {
            orderId: payment.orderId,
            toStatus: "REFUNDED",
            actorType: "SYSTEM",
            note: "Payment arrived after the order was cancelled; it was refunded automatically",
          },
        });
        return "refunded";
      }

      const items = await tx.orderItem.findMany({
        where: { orderId: payment.orderId },
        select: { id: true, kind: true, variantId: true, designId: true, quoteRequestId: true },
      });
      await transitionItems(tx, { itemIds: items.map((i) => i.id), to: "PAID", actor: SYSTEM, note: "Payment received" });
      await transitionItems(tx, {
        itemIds: items.filter((i) => i.kind === "CUSTOM_DESIGN").map((i) => i.id),
        to: "AWAITING_ACCEPTANCE",
        actor: SYSTEM,
        note: "Waiting for ClothSeeker to accept the custom order",
        data: { acceptBy: new Date(now.getTime() + ACCEPTANCE_WINDOW_MS) },
      });
      await transitionItems(tx, {
        itemIds: items.filter((i) => i.kind === "QUOTE").map((i) => i.id),
        to: "ACCEPTED",
        actor: SYSTEM,
        note: "Quoted price paid",
      });
      await tx.orderEvent.create({
        data: { orderId: payment.orderId, fromStatus: "PENDING_PAYMENT", toStatus: "PAID", actorType: "SYSTEM", note: "Payment received" },
      });
      const paidOrder = await tx.order.findUniqueOrThrow({ where: { id: payment.orderId }, select: { customerId: true } });
      await notify(tx, { customerId: paidOrder.customerId, kind: "ORDER_CONFIRMED", uniqueKey: `ORDER_CONFIRMED:${payment.orderId}`, payload: { orderId: payment.orderId } });

      // The quoted price is agreed: the quote is now an order (even if it expired while the payment was in flight).
      const quoteIds = items.flatMap((i) => (i.kind === "QUOTE" && i.quoteRequestId ? [i.quoteRequestId] : []));
      if (quoteIds.length > 0) {
        await tx.quoteRequest.updateMany({ where: { id: { in: quoteIds }, status: { in: ["QUOTED", "EXPIRED"] } }, data: { status: "ACCEPTED" } });
      }
      const designIds = items.flatMap((i) => (i.designId ? [i.designId] : []));
      const variantIds = items.flatMap((i) => (i.kind === "READY_MADE" && i.variantId ? [i.variantId] : []));
      if (designIds.length > 0) {
        await tx.design.updateMany({ where: { id: { in: designIds } }, data: { status: "ORDERED" } });
      }
      // The paid lines leave the cart; anything added since stays.
      const order = await tx.order.findUniqueOrThrow({ where: { id: payment.orderId }, select: { customerId: true } });
      await tx.cartItem.deleteMany({
        where: {
          cart: { customerId: order.customerId },
          OR: [{ designId: { in: designIds } }, { quoteRequestId: { in: quoteIds } }, { kind: "READY_MADE", variantId: { in: variantIds } }],
        },
      });
      return "paid";
    });
  } catch (error) {
    // A concurrent delivery of the same event lost the race on the unique eventId.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return "duplicate";
    }
    throw error;
  }

  if (outcome === "refunded") {
    await provider.refund(event.providerRef, event.amountMinor);
  }
  await removeOrderFiles(storage, filesToRemove);
  return outcome;
}
