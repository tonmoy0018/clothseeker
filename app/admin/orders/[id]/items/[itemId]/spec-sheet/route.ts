import { getCurrentUser } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db";
import { getServerEnv } from "@/lib/env/server";
import { buildSpecSheet } from "@/lib/production/pdf/spec-sheet";
import { pdfResponse } from "@/lib/production/pdf/response";
import { getAdminOrder } from "@/lib/production/queries";
import { specSheetData } from "@/lib/production/spec-data";
import { getStorage } from "@/lib/storage/supabase";

export async function GET(_request: Request, { params }: RouteContext<"/admin/orders/[id]/items/[itemId]/spec-sheet">) {
  const user = await getCurrentUser();
  if (!user || user.role !== "ADMIN") {
    return new Response("Not found", { status: 404 });
  }
  const { id, itemId } = await params;
  const db = getPrisma();
  const order = await getAdminOrder(db, user, id);
  const item = order?.items.find((i) => i.id === itemId);
  if (!order || !item) {
    return new Response("Not found", { status: 404 });
  }
  const adminUrl = new URL(`/admin/orders/${order.id}#item-${item.id}`, getServerEnv().NEXT_PUBLIC_APP_URL).toString();
  const pdf = await buildSpecSheet(await specSheetData(db, getStorage(), order, item, adminUrl));
  return pdfResponse(pdf, `spec-${order.number}-${item.id.slice(0, 8)}.pdf`);
}
