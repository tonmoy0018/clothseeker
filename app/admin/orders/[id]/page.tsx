import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ActionForm, SubmitButton } from "@/components/admin/action-form";
import { PhotoUploadForm } from "@/components/admin/photo-upload-form";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { requireAdmin } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { formatBDT, lineTotalMinor } from "@/lib/money";
import { DELIVERY_ZONE_LABEL } from "@/lib/orders/delivery";
import { ITEM_STATUS_LABEL, ORDER_STATUS_LABEL, statusLabel } from "@/lib/orders/labels";
import { getAdminOrder, type AdminOrder } from "@/lib/production/queries";
import { BUCKETS } from "@/lib/storage/buckets";
import { getStorage } from "@/lib/storage/supabase";

import {
  acceptAction,
  approveQcAction,
  declineAction,
  qcPhotoAction,
  readyAction,
  rejectQcAction,
  shipAction,
  simulateCourierAction,
  startProductionAction,
  submitQcAction,
} from "./actions";

export const metadata: Metadata = { title: "Order — ClothSeeker admin" };

const when = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Dhaka" });
type Item = AdminOrder["items"][number];

export default async function AdminOrderPage({ params }: PageProps<"/admin/orders/[id]">) {
  const admin = await requireAdmin();
  const { id } = await params;
  const order = await getAdminOrder(getPrisma(), admin, id);
  if (!order) {
    notFound();
  }
  const storage = getStorage();
  const [designUrls, qcUrls] = await Promise.all([
    storage.signReadUrls(BUCKETS.designAssets, order.items.flatMap((i) => [...(i.previewKey ? [i.previewKey] : []), ...i.printFiles.map((f) => f.key)])),
    storage.signReadUrls(BUCKETS.qcPhotos, order.items.flatMap((i) => i.qcPhotos.map((p) => p.storageKey))),
  ]);
  const refunded = order.refunds.reduce((sum, r) => sum + r.amountMinor, 0);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <Link href="/admin/orders" className="text-sm text-muted-foreground hover:text-foreground">
          ← Orders
        </Link>
        <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold">
          Order {order.number} <Badge variant="secondary">{ORDER_STATUS_LABEL[order.status]}</Badge>
        </h1>
        <p className="text-sm text-muted-foreground">
          Placed {when.format(order.createdAt)}
          {order.paidAt ? ` · paid ${when.format(order.paidAt)}` : ""}
        </p>
      </div>

      <div className="flex flex-col gap-4">
        {order.items.map((item) => (
          <ItemCard key={item.id} order={order} item={item} designUrls={designUrls} qcUrls={qcUrls} />
        ))}
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Ship to</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {order.shippingLine1 ? (
              <address className="not-italic">
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
                {order.shippingCity} {order.shippingPostalCode}
                <br />
                {order.deliveryZone && DELIVERY_ZONE_LABEL[order.deliveryZone]}
              </address>
            ) : (
              "No address"
            )}
            <p className="mt-2 text-xs text-muted-foreground">The phone number is printed on the shipping label only.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Customer note</CardTitle>
          </CardHeader>
          <CardContent className="text-sm" data-testid="customer-note">
            {order.customerNote ?? <span className="text-muted-foreground">None</span>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Payment</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 text-sm">
            <div className="flex justify-between">
              <span>Total</span>
              <span>{formatBDT(order.totalMinor)}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>Delivery</span>
              <span>{formatBDT(order.deliveryFeeMinor)}</span>
            </div>
            {order.refunds.map((r) => (
              <div key={r.id} className="flex justify-between text-destructive">
                <span>
                  Refund ({r.kind === "ITEM" ? "item" : "delivery"}){r.status === "PENDING" ? " — pending" : ""}
                </span>
                <span>−{formatBDT(r.amountMinor)}</span>
              </div>
            ))}
            {refunded > 0 && (
              <div className="flex justify-between border-t pt-1 font-medium">
                <span>Kept</span>
                <span>{formatBDT(order.totalMinor - refunded)}</span>
              </div>
            )}
            <p className="text-xs text-muted-foreground">Payment {order.payments[0]?.status.toLowerCase() ?? "—"} (simulated)</p>
          </CardContent>
        </Card>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Timeline</h2>
        <ol className="flex flex-col gap-2 border-l pl-4 text-sm" data-testid="admin-timeline">
          {order.events.map((event) => {
            const item = order.items.find((i) => i.id === event.orderItemId);
            return (
              <li key={event.id}>
                <strong>{statusLabel(event.toStatus)}</strong>
                {item ? ` · ${item.productName}` : ""} · {event.actorType.toLowerCase()}
                {event.note ? ` — ${event.note}` : ""}
                <span className="block text-xs text-muted-foreground">{when.format(event.createdAt)}</span>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}

function Hidden({ order, item }: { order: AdminOrder; item: Item }) {
  return (
    <>
      <input type="hidden" name="orderId" value={order.id} />
      <input type="hidden" name="itemId" value={item.id} />
    </>
  );
}

function ItemCard({ order, item, designUrls, qcUrls }: { order: AdminOrder; item: Item; designUrls: Map<string, string>; qcUrls: Map<string, string> }) {
  const preview = item.previewKey ? designUrls.get(item.previewKey) : undefined;
  const madeToOrder = item.kind !== "READY_MADE";
  const latest = (side: "FRONT" | "BACK") => item.qcPhotos.find((p) => p.side === side);
  const overdue = item.status === "AWAITING_ACCEPTANCE" && item.acceptBy && item.acceptBy < new Date();

  return (
    <Card id={`item-${item.id}`} data-testid="admin-item">
      <CardContent className="flex flex-col gap-4 pt-1">
        <div className="flex flex-wrap gap-4">
          {madeToOrder && (
            <div className="relative h-36 w-28 shrink-0 overflow-hidden rounded-lg bg-muted">
              {preview && <Image src={preview} alt={`Approved design for ${item.productName}`} fill unoptimized className="object-contain" />}
            </div>
          )}
          <div className="flex min-w-60 flex-1 flex-col gap-1 text-sm">
            <span className="text-base font-medium">
              {item.productName}
              {item.kind === "CUSTOM_DESIGN" ? " — custom design" : ""}
            </span>
            <span className="text-muted-foreground">
              Size {item.size}
              {item.colorName ? ` · ${item.colorName}` : ""} · × {item.quantity} · {formatBDT(lineTotalMinor(item.unitPriceMinor, item.quantity))}
            </span>
            <span>
              <Badge data-testid="item-status">{ITEM_STATUS_LABEL[item.status]}</Badge>
              {item.status === "AWAITING_ACCEPTANCE" && item.acceptBy && (
                <span className={overdue ? "ml-2 text-destructive" : "ml-2 text-amber-700 dark:text-amber-400"}>
                  {overdue ? "Deadline passed — refunding" : `Accept by ${when.format(item.acceptBy)}`}
                </span>
              )}
            </span>
            <div className="mt-1 flex flex-wrap gap-3">
              <a href={`/admin/orders/${order.id}/items/${item.id}/spec-sheet`} target="_blank" rel="noopener" className="underline underline-offset-4">
                Spec sheet (PDF)
              </a>
              {item.printFiles.map((f) => {
                const url = designUrls.get(f.key);
                return url ? (
                  <a key={f.key} href={url} target="_blank" rel="noopener" className="underline underline-offset-4">
                    Print file: {f.label} ({f.widthCm}×{f.heightCm} cm)
                  </a>
                ) : null;
              })}
            </div>
          </div>
        </div>

        {item.shipment && (
          <div className="rounded-lg bg-muted/50 p-3 text-sm" data-testid="shipment">
            {item.shipment.carrier} · <strong>{item.shipment.trackingNumber}</strong> · {item.shipment.status.replaceAll("_", " ").toLowerCase()}{" "}
            <a href={`/admin/orders/${order.id}/items/${item.id}/label`} target="_blank" rel="noopener" className="ml-2 underline underline-offset-4">
              Shipping label (PDF)
            </a>
            {item.shipment.courierEvents.length > 0 && (
              <ul className="mt-1 text-xs text-muted-foreground">
                {item.shipment.courierEvents.map((e) => (
                  <li key={e.id}>
                    {when.format(e.createdAt)} — {e.status.replaceAll("_", " ").toLowerCase()}
                    {e.note ? `: ${e.note}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {(item.status === "IN_PRODUCTION" || item.status === "QC_SUBMITTED") && (
          <div className="flex flex-wrap gap-6">
            {(["FRONT", "BACK"] as const).map((side) => {
              const p = latest(side);
              const url = p ? qcUrls.get(p.storageKey) : undefined;
              return (
                <div key={side} className="flex flex-col gap-2">
                  <span className="text-sm font-medium">QC photo — {side.toLowerCase()}</span>
                  <div className="relative h-32 w-24 overflow-hidden rounded bg-muted">
                    {url && <Image src={url} alt={`QC ${side.toLowerCase()}`} fill unoptimized className="object-cover" />}
                  </div>
                  {item.status === "IN_PRODUCTION" && (
                    <PhotoUploadForm
                      action={qcPhotoAction}
                      hidden={{ orderId: order.id, itemId: item.id, side, slot: `qc-${item.id}-${side}` }}
                      label={`Upload ${side.toLowerCase()} photo`}
                      hint="JPEG, PNG or WebP, at least 600×600 px."
                      fileField="photo"
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="flex flex-wrap items-start gap-3">
          {item.status === "AWAITING_ACCEPTANCE" && !overdue && (
            <>
              <ActionForm action={acceptAction}>
                <Hidden order={order} item={item} />
                <SubmitButton pendingLabel="Accepting…">Accept</SubmitButton>
              </ActionForm>
              <ActionForm action={declineAction} className="flex items-center gap-2">
                <Hidden order={order} item={item} />
                <Input name="reason" placeholder="Reason for the customer" required minLength={3} maxLength={200} className="h-8 w-56" aria-label="Decline reason" />
                <SubmitButton variant="outline" pendingLabel="Declining…">
                  Decline & refund
                </SubmitButton>
              </ActionForm>
            </>
          )}
          {item.status === "PAID" && item.kind === "READY_MADE" && (
            <ActionForm action={readyAction}>
              <Hidden order={order} item={item} />
              <SubmitButton>Mark ready to ship</SubmitButton>
            </ActionForm>
          )}
          {item.status === "ACCEPTED" && (
            <ActionForm action={startProductionAction}>
              <Hidden order={order} item={item} />
              <SubmitButton>Start production</SubmitButton>
            </ActionForm>
          )}
          {item.status === "IN_PRODUCTION" && (
            <ActionForm action={submitQcAction}>
              <Hidden order={order} item={item} />
              <SubmitButton>Submit for QC</SubmitButton>
            </ActionForm>
          )}
          {item.status === "QC_SUBMITTED" && (
            <>
              <ActionForm action={approveQcAction}>
                <Hidden order={order} item={item} />
                <SubmitButton>Approve QC</SubmitButton>
              </ActionForm>
              <ActionForm action={rejectQcAction} className="flex items-center gap-2">
                <Hidden order={order} item={item} />
                <Input name="note" placeholder="What needs fixing" required minLength={3} maxLength={300} className="h-8 w-56" aria-label="QC rejection note" />
                <SubmitButton variant="outline">Reject QC</SubmitButton>
              </ActionForm>
            </>
          )}
          {item.status === "READY_TO_SHIP" && (
            <ActionForm action={shipAction}>
              <Hidden order={order} item={item} />
              <SubmitButton pendingLabel="Booking courier…">Ship with Mock Courier</SubmitButton>
            </ActionForm>
          )}
          {item.status === "SHIPPED" && item.shipment?.trackingNumber && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">Simulate courier:</span>
              {(["in_transit", "out_for_delivery", "delivered"] as const).map((status) => (
                <ActionForm key={status} action={simulateCourierAction}>
                  <input type="hidden" name="orderId" value={order.id} />
                  <input type="hidden" name="trackingNumber" value={item.shipment?.trackingNumber ?? ""} />
                  <input type="hidden" name="status" value={status} />
                  <SubmitButton size="sm" variant="outline" pendingLabel="Sending…">
                    {status.replaceAll("_", " ")}
                  </SubmitButton>
                </ActionForm>
              ))}
            </div>
          )}
          {(item.status === "DELIVERED" || item.status === "REFUNDED" || item.status === "CANCELLED") && (
            <span className="text-sm text-muted-foreground">No further actions.</span>
          )}
        </div>
        {!madeToOrder && item.status === "PAID" && (
          <p className="text-xs text-muted-foreground">Ready-made: pick from stock, pack, then mark ready.</p>
        )}
        <Link href={`/admin/orders?tab=all&q=${order.number}`} className={buttonVariants({ variant: "link", size: "xs", className: "w-fit px-0" })}>
          Find this order in the queue
        </Link>
      </CardContent>
    </Card>
  );
}
