import type { NotificationKind } from "@/lib/generated/prisma/enums";

// Customer email texts (pure, unit tested). They only ever contain the customer's first name, the
// order number, product names, a tracking number or quote price, the team's note and a link back
// to the shop. Never an address, phone number or image.

export type EmailData = {
  firstName: string | null;
  link: string;
  orderNumber?: string;
  items?: string[];
  trackingNumbers?: string[];
  productName?: string;
  price?: string;
  note?: string | null;
  /** QUOTE_EXPIRED: whether a price had been sent (else nobody replied in time). */
  hadPrice?: boolean;
};

export type RenderedEmail = { subject: string; text: string; html: string };

function list(items: readonly string[] | undefined): string {
  const names = items ?? [];
  if (names.length <= 1) return names[0] ?? "your item";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function content(kind: NotificationKind, d: EmailData): { subject: string; lines: string[]; action: string } {
  const order = d.orderNumber ? `order ${d.orderNumber}` : "your order";
  switch (kind) {
    case "ORDER_CONFIRMED":
      return {
        subject: `Order ${d.orderNumber ?? ""} confirmed`.trim(),
        lines: [`Thank you! We've received your payment for ${order}.`, `It includes ${list(d.items)}. Custom designs are confirmed by our team within 24 hours.`],
        action: "View your order",
      };
    case "DESIGN_ACCEPTED":
      return {
        subject: `We're making your design (${d.orderNumber ?? ""})`,
        lines: [`Good news: the ClothSeeker team accepted ${list(d.items)} from ${order} and is starting work on it.`],
        action: "Follow your order",
      };
    case "ITEM_REFUNDED":
      return {
        subject: `Refund for ${order}`,
        lines: [`We've refunded ${list(d.items)} from ${order} in full.`, ...(d.note ? [`Reason: ${d.note}`] : []), "The money goes back to the payment method you used."],
        action: "See the details",
      };
    case "SHIPPED":
      return {
        subject: `Your order ${d.orderNumber ?? ""} is on its way`,
        lines: [`${list(d.items)} has shipped.`, ...(d.trackingNumbers && d.trackingNumbers.length > 0 ? [`Tracking: ${d.trackingNumbers.join(", ")}`] : [])],
        action: "Track your order",
      };
    case "DELIVERED":
      return {
        subject: `Delivered: ${d.orderNumber ?? "your order"}`,
        lines: [`${list(d.items)} has been delivered. We hope you love it!`, "If something isn't right, you can report a problem from your order page within 14 days."],
        action: "View your order",
      };
    case "QUOTE_READY":
      return {
        subject: `Your tailoring quote is ready${d.price ? `: ${d.price}` : ""}`,
        lines: [`We've priced your tailoring request for the ${d.productName ?? "dress"}${d.price ? ` at ${d.price}` : ""} (before delivery).`, ...(d.note ? [`From the team: ${d.note}`] : []), "The price is valid for 7 days."],
        action: "See your quote",
      };
    case "QUOTE_DECLINED":
      return {
        subject: "About your tailoring request",
        lines: [`Sorry, we can't make the ${d.productName ?? "dress"} you asked about.`, ...(d.note ? [`From the team: ${d.note}`] : [])],
        action: "See the details",
      };
    case "QUOTE_EXPIRED":
      return d.hadPrice
        ? {
            subject: "Your tailoring quote has expired",
            lines: [`The price for the ${d.productName ?? "dress"} was valid for 7 days and has now expired. You can request a new quote from your design.`],
            action: "Open your quotes",
          }
        : {
            subject: "We couldn't reply to your tailoring request in time",
            lines: [`Sorry, we didn't manage to price the ${d.productName ?? "dress"} within 24 hours. Please request a new quote from your design.`],
            action: "Open your quotes",
          };
    case "DISPUTE_REFUNDED":
      return {
        subject: `We've refunded ${order}`,
        lines: [`About the problem you reported with ${list(d.items)}: we've refunded it in full.`, ...(d.note ? [`From the team: ${d.note}`] : [])],
        action: "See the details",
      };
    case "DISPUTE_CLOSED":
      return {
        subject: `About the problem you reported (${d.orderNumber ?? ""})`,
        lines: [`We've reviewed the problem you reported with ${list(d.items)}.`, ...(d.note ? [`From the team: ${d.note}`] : [])],
        action: "See the details",
      };
  }
}

export function renderEmail(kind: NotificationKind, data: EmailData): RenderedEmail {
  const { subject, lines, action } = content(kind, data);
  const greeting = `Hi ${data.firstName ?? "there"},`;
  const text = [greeting, "", ...lines, "", `${action}: ${data.link}`, "", "— ClothSeeker"].join("\n");
  const html = [
    '<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1b1b1b;max-width:560px">',
    `<p>${escapeHtml(greeting)}</p>`,
    ...lines.map((l) => `<p>${escapeHtml(l)}</p>`),
    `<p><a href="${escapeHtml(data.link)}" style="display:inline-block;padding:10px 16px;background:#1b1b1b;color:#ffffff;border-radius:8px;text-decoration:none">${escapeHtml(action)}</a></p>`,
    '<p style="color:#6b6b6b;font-size:13px">— ClothSeeker</p>',
    "</div>",
  ].join("");
  return { subject, text, html };
}
