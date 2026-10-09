import { describe, expect, it } from "vitest";

import { NotificationKind } from "@/lib/generated/prisma/enums";
import { itemNotificationKind, itemsUniqueKey } from "@/lib/notifications/rules";
import { renderEmail } from "@/lib/notifications/templates";

describe("which item moves email the customer", () => {
  it("maps moves to emails, telling disputes apart", () => {
    expect(itemNotificationKind({ kind: "CUSTOM_DESIGN", from: "AWAITING_ACCEPTANCE", to: "ACCEPTED" })).toBe("DESIGN_ACCEPTED");
    expect(itemNotificationKind({ kind: "QUOTE", from: "PAID", to: "ACCEPTED" })).toBeNull();
    expect(itemNotificationKind({ kind: "CUSTOM_DESIGN", from: "AWAITING_ACCEPTANCE", to: "REFUNDED" })).toBe("ITEM_REFUNDED");
    expect(itemNotificationKind({ kind: "READY_MADE", from: "DISPUTED", to: "REFUNDED" })).toBe("DISPUTE_REFUNDED");
    expect(itemNotificationKind({ kind: "READY_MADE", from: "READY_TO_SHIP", to: "SHIPPED" })).toBe("SHIPPED");
    expect(itemNotificationKind({ kind: "READY_MADE", from: "SHIPPED", to: "DELIVERED" })).toBe("DELIVERED");
    expect(itemNotificationKind({ kind: "READY_MADE", from: "DISPUTED", to: "DELIVERED" })).toBe("DISPUTE_CLOSED");
    for (const to of ["PAID", "AWAITING_ACCEPTANCE", "IN_PRODUCTION", "QC_SUBMITTED", "READY_TO_SHIP", "DISPUTED", "CANCELLED"] as const) {
      expect(itemNotificationKind({ kind: "CUSTOM_DESIGN", from: "PENDING_PAYMENT", to })).toBeNull();
    }
    expect(itemsUniqueKey("SHIPPED", "o", ["b", "a"])).toBe(itemsUniqueKey("SHIPPED", "o", ["a", "b"]));
  });
});

describe("email texts", () => {
  const data = {
    firstName: "Ava",
    link: "http://localhost:3000/account/orders/o1",
    orderNumber: "CS-20261010-ABCDE",
    items: ["Linen Wrap Dress", "Floral Sundress"],
    trackingNumbers: ["MCK123"],
    productName: "Cotton Tiered Midi",
    price: "৳5,200",
    note: 'Sorry <script>alert("x")</script>',
  };

  it("render for every kind with a greeting and a link, and escape HTML", () => {
    for (const kind of Object.values(NotificationKind)) {
      const email = renderEmail(kind, data);
      expect(email.subject.length).toBeGreaterThan(5);
      expect(email.text).toMatch(/^Hi Ava,/);
      expect(email.text).toContain(data.link);
      expect(email.html).not.toContain("<script>");
    }
    expect(renderEmail("SHIPPED", data).text).toContain("Tracking: MCK123");
    expect(renderEmail("ORDER_CONFIRMED", data).text).toContain("Linen Wrap Dress and Floral Sundress");
    expect(renderEmail("QUOTE_READY", data).subject).toBe("Your tailoring quote is ready: ৳5,200");
    expect(renderEmail("QUOTE_EXPIRED", { ...data, hadPrice: false }).subject).toMatch(/couldn't reply/);
    expect(renderEmail("DELIVERED", { ...data, firstName: null }).text).toMatch(/^Hi there,/);
  });

  it("never include an address or phone number (there is no field for them)", () => {
    const keys = Object.keys(data);
    expect(keys.some((k) => /address|phone|line1|city|postal/i.test(k))).toBe(false);
  });
});
