import { getCurrentUser } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db";
import { buildShippingLabel } from "@/lib/production/pdf/label";
import { pdfResponse } from "@/lib/production/pdf/response";
import { getAdminOrder } from "@/lib/production/queries";

export async function GET(_request: Request, { params }: RouteContext<"/admin/orders/[id]/items/[itemId]/label">) {
  const user = await getCurrentUser();
  if (!user || user.role !== "ADMIN") {
    return new Response("Not found", { status: 404 });
  }
  const { id, itemId } = await params;
  const order = await getAdminOrder(getPrisma(), user, id);
  const item = order?.items.find((i) => i.id === itemId);
  if (!order || !item?.shipment?.trackingNumber || !order.shippingLine1 || !order.shippingName || !order.shippingCity || !order.shippingPhone) {
    return new Response("Not found", { status: 404 });
  }
  const pdf = await buildShippingLabel({
    carrier: item.shipment.carrier,
    trackingNumber: item.shipment.trackingNumber,
    orderNumber: order.number,
    recipient: {
      name: order.shippingName,
      line1: order.shippingLine1,
      line2: order.shippingLine2,
      city: order.shippingCity,
      postalCode: order.shippingPostalCode,
      phone: order.shippingPhone,
    },
  });
  return pdfResponse(pdf, `label-${item.shipment.trackingNumber}.pdf`);
}
