import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { requireUser } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { formatBDT, lineTotalMinor } from "@/lib/money";
import { DELIVERY_ZONE_LABEL } from "@/lib/orders/delivery";
import { ITEM_STATUS_LABEL, ORDER_STATUS_LABEL, statusLabel } from "@/lib/orders/labels";
import { getOrderForCustomer, type OrderDetail } from "@/lib/orders/queries";
import { HAPPY_PATH } from "@/lib/orders/transitions";
import { BUCKETS } from "@/lib/storage/buckets";
import { getStorage } from "@/lib/storage/supabase";
import { cn } from "@/lib/utils";

import { ResumePayment } from "./resume-payment";

export const metadata: Metadata = { title: "Order — ClothSeeker" };

const when = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Dhaka" });

const COURIER_LABEL = { LABEL_CREATED: "Label created", IN_TRANSIT: "In transit", OUT_FOR_DELIVERY: "Out for delivery", DELIVERED: "Delivered" } as const;

export default async function OrderDetailPage({ params }: PageProps<"/account/orders/[id]">) {
  const { id } = await params;
  const user = await requireUser(`/account/orders/${id}`);
  const order = await getOrderForCustomer(getPrisma(), user, id);
  if (!order) {
    notFound();
  }
  const previews = await getStorage().signReadUrls(
    BUCKETS.designAssets,
    order.items.flatMap((i) => (i.previewKey ? [i.previewKey] : [])),
  );
  const now = new Date();
  const payable = order.status === "PENDING_PAYMENT" && (!order.expiresAt || order.expiresAt > now);
  const payment = order.payments[0];
  const refundReason = (itemId: string) => {
    const reason = order.refunds.find((r) => r.kind === "ITEM" && r.orderItemId === itemId)?.reason;
    return reason?.replace(/^Declined by ClothSeeker: /, "");
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Link href="/account/orders" className="text-sm text-muted-foreground hover:text-foreground">
            ← My orders
          </Link>
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold">
            Order {order.number}
            <Badge variant={order.status === "PAID" ? "default" : "secondary"} data-testid="order-status">
              {ORDER_STATUS_LABEL[order.status]}
            </Badge>
          </h1>
          <p className="text-sm text-muted-foreground">Placed {when.format(order.createdAt)}</p>
        </div>
        {payable && (
          <div className="flex flex-col items-end gap-1 text-sm">
            <ResumePayment orderId={order.id} />
            {order.expiresAt && <span className="text-muted-foreground">Pay by {when.format(order.expiresAt)} or the order is released.</span>}
          </div>
        )}
      </div>

      {order.status === "PAID" && (
        <div role="status" className="rounded-xl border border-emerald-600/30 bg-emerald-50 p-4 text-sm dark:bg-emerald-950/30">
          Thank you! Your payment was received.{" "}
          {order.items.some((i) => i.kind === "CUSTOM_DESIGN") && "ClothSeeker will confirm your custom design within 24 hours."}
        </div>
      )}
      {order.status === "CANCELLED" && (
        <div className="rounded-xl border p-4 text-sm">
          This order was cancelled and nothing was charged.{" "}
          {payment?.status === "REFUNDED" && "A payment that arrived late was refunded automatically. "}
          <Link href="/cart" className="underline underline-offset-4">
            Your cart
          </Link>{" "}
          still has your items if you want to try again.
        </div>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Items</h2>
        <ul className="flex flex-col divide-y rounded-xl border" data-testid="order-items">
          {order.items.map((item) => {
            const preview = item.previewKey ? previews.get(item.previewKey) : undefined;
            return (
              <li key={item.id} className="flex flex-col gap-3 p-4">
                <div className="flex gap-4">
                  {item.kind === "CUSTOM_DESIGN" && (
                    <div className="relative size-20 shrink-0 overflow-hidden rounded-lg bg-muted">
                      {preview && <Image src={preview} alt={`Your design for ${item.productName}`} fill unoptimized className="object-contain" />}
                    </div>
                  )}
                  <div className="flex flex-1 flex-col gap-1">
                    <span className="font-medium">
                      {item.productName}
                      {item.kind === "CUSTOM_DESIGN" && " — your design"}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      Size {item.size}
                      {item.colorName ? ` · ${item.colorName}` : ""} · × {item.quantity}
                      {item.kind === "CUSTOM_DESIGN" && item.printFiles.length > 0 && ` · ${item.printFiles.length} print file${item.printFiles.length === 1 ? "" : "s"} ready`}
                    </span>
                    {item.status === "AWAITING_ACCEPTANCE" && item.acceptBy && (
                      <span className="text-sm">ClothSeeker will confirm by {when.format(item.acceptBy)}.</span>
                    )}
                    {item.status === "REFUNDED" && (
                      <span className="text-sm">This item was refunded in full{refundReason(item.id) ? `: ${refundReason(item.id)}` : "."}</span>
                    )}
                    {item.shipment && (
                      <div className="mt-1 rounded-lg bg-muted/50 p-2 text-sm" data-testid="tracking">
                        {item.shipment.carrier} · tracking <strong>{item.shipment.trackingNumber}</strong>
                        <ul className="mt-1 text-xs text-muted-foreground">
                          {item.shipment.courierEvents.map((e) => (
                            <li key={e.id}>
                              {when.format(e.createdAt)} — {COURIER_LABEL[e.status]}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                  <span className="font-medium">{formatBDT(lineTotalMinor(item.unitPriceMinor, item.quantity))}</span>
                </div>
                <StatusStepper item={item} />
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-muted-foreground">Tracking details appear here once an item ships.</p>
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <section className="flex flex-col gap-2 text-sm">
          <h2 className="text-lg font-semibold">Delivery</h2>
          {order.shippingLine1 ? (
            <address className="not-italic text-muted-foreground">
              {order.shippingName}
              <br />
              {order.shippingLine1}
              {order.shippingLine2 && (
                <>
                  <br />
                  {order.shippingLine2}
                </>
              )}
              <br />
              {order.shippingCity}
              {order.shippingPostalCode ? ` ${order.shippingPostalCode}` : ""}
              <br />
              {order.shippingPhone}
            </address>
          ) : (
            <p className="text-muted-foreground">No address on file for this order.</p>
          )}
          {order.deliveryZone && <p>{DELIVERY_ZONE_LABEL[order.deliveryZone]}</p>}
        </section>

        <section className="flex flex-col gap-1 text-sm">
          <h2 className="text-lg font-semibold">Payment</h2>
          <div className="flex justify-between">
            <span>Subtotal</span>
            <span>{formatBDT(order.subtotalMinor || order.totalMinor)}</span>
          </div>
          <div className="flex justify-between">
            <span>Delivery</span>
            <span>{formatBDT(order.deliveryFeeMinor)}</span>
          </div>
          <div className="flex justify-between border-t pt-1 font-semibold">
            <span>Total</span>
            <span data-testid="order-total">{formatBDT(order.totalMinor)}</span>
          </div>
          {order.refunds.map((r) => (
            <div key={r.id} className="flex justify-between text-emerald-700 dark:text-emerald-400" data-testid="refund">
              <span>{r.kind === "ITEM" ? "Refunded" : "Delivery fee refunded"}{r.status === "PENDING" ? " (processing)" : ""}</span>
              <span>{formatBDT(r.amountMinor)}</span>
            </div>
          ))}
          {payment && <p className="text-muted-foreground">Payment: {payment.status.toLowerCase()} (simulated)</p>}
        </section>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Timeline</h2>
        <ol className="flex flex-col gap-2 border-l pl-4 text-sm" data-testid="order-timeline">
          {order.events.map((event) => {
            const item = order.items.find((i) => i.id === event.orderItemId);
            return (
              <li key={event.id} className="flex flex-col">
                <span>
                  <strong>{statusLabel(event.toStatus)}</strong>
                  {item ? ` · ${item.productName}` : ""}
                  {event.note ? ` — ${event.note}` : ""}
                </span>
                <span className="text-xs text-muted-foreground">{when.format(event.createdAt)}</span>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}

function StatusStepper({ item }: { item: OrderDetail["items"][number] }) {
  if (item.status === "CANCELLED" || item.status === "REFUNDED" || item.status === "DISPUTED") {
    return <Badge variant="secondary">{ITEM_STATUS_LABEL[item.status]}</Badge>;
  }
  const steps = HAPPY_PATH[item.kind].filter((s) => s !== "PENDING_PAYMENT");
  const current = steps.findIndex((s) => s === item.status);
  return (
    <ol className="flex flex-wrap gap-x-2 gap-y-1 text-xs" aria-label="Progress" data-testid="item-progress">
      {steps.map((step, index) => (
        <li
          key={step}
          aria-current={index === current ? "step" : undefined}
          className={cn(
            "rounded-full px-2 py-0.5",
            index < current && "bg-muted text-muted-foreground",
            index === current && "bg-foreground text-background",
            index > current && "text-muted-foreground",
          )}
        >
          {ITEM_STATUS_LABEL[step]}
        </li>
      ))}
    </ol>
  );
}
