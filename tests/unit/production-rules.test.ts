import { inflateSync } from "node:zlib";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { MOCK_COURIER_SIGNATURE_HEADER, MockCourier } from "@/lib/couriers/mock";
import { CourierWebhookVerificationError } from "@/lib/couriers/types";
import { buildShippingLabel } from "@/lib/production/pdf/label";
import { buildSpecSheet, type SpecSheetData } from "@/lib/production/pdf/spec-sheet";
import { pdfSafe } from "@/lib/production/pdf/text";
import { qcPhotosComplete } from "@/lib/production/production";
import { orderFullyEnded } from "@/lib/production/refunds";
import { generateTrackingNumber } from "@/lib/production/shipping";

/** All text drawn on a pdf-lib PDF (decompresses content streams, decodes hex strings). */
function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes);
  const out: string[] = [];
  let index = 0;
  while ((index = raw.indexOf("stream", index)) !== -1) {
    const start = raw[index + 6] === 0x0d ? index + 8 : index + 7;
    const end = raw.indexOf("endstream", start);
    if (end === -1) break;
    try {
      const content = inflateSync(raw.subarray(start, end)).toString("latin1");
      for (const match of content.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
        out.push(Buffer.from(match[1] ?? "", "hex").toString("latin1"));
      }
    } catch {
      // not a Flate stream (images etc.)
    }
    index = end;
  }
  return out.join("\n");
}

describe("pdfSafe", () => {
  it("maps symbols the standard fonts can't draw", () => {
    expect(pdfSafe("৳3,450 — “Mia’s” dress × 2…")).toBe(`BDT 3,450 - "Mia's" dress x 2...`);
    expect(pdfSafe("আমার পোশাক")).toMatch(/^\?+ \?+$/);
    expect(pdfSafe("Café\tok")).toBe("Café ok");
  });
});

describe("refund rules", () => {
  it("an order ends only when every item is cancelled or refunded", () => {
    expect(orderFullyEnded(["REFUNDED"])).toBe(true);
    expect(orderFullyEnded(["REFUNDED", "CANCELLED"])).toBe(true);
    expect(orderFullyEnded(["REFUNDED", "PAID"])).toBe(false);
    expect(orderFullyEnded([])).toBe(false);
  });
});

describe("QC prerequisites", () => {
  const started = new Date("2026-10-09T10:00:00Z");
  const before = new Date("2026-10-09T09:00:00Z");
  const after = new Date("2026-10-09T11:00:00Z");

  it("needs a front and a back photo from the current production round", () => {
    expect(qcPhotosComplete([{ side: "FRONT", createdAt: after }, { side: "BACK", createdAt: after }], started)).toBe(true);
    expect(qcPhotosComplete([{ side: "FRONT", createdAt: after }], started)).toBe(false);
    expect(qcPhotosComplete([{ side: "FRONT", createdAt: after }, { side: "BACK", createdAt: before }], started)).toBe(false);
  });
});

describe("tracking numbers and courier webhooks", () => {
  it("formats tracking numbers", () => {
    expect(generateTrackingNumber(() => 0)).toBe("MCK2222222222");
    expect(generateTrackingNumber()).toMatch(/^MCK[2-9A-HJ-NP-Z]{10}$/);
  });

  const courier = new MockCourier("test-courier-secret-0123456789abcdef");
  const body = JSON.stringify({ eventId: "cev_12345678", trackingNumber: "MCK2222222222", status: "delivered" });

  it("accepts signed events and rejects tampered or unsigned ones", () => {
    expect(courier.parseWebhook(body, new Headers({ [MOCK_COURIER_SIGNATURE_HEADER]: courier.sign(body) })).status).toBe("delivered");
    const tampered = body.replace("delivered", "in_transit");
    expect(() => courier.parseWebhook(tampered, new Headers({ [MOCK_COURIER_SIGNATURE_HEADER]: courier.sign(body) }))).toThrow(
      CourierWebhookVerificationError,
    );
    expect(() => courier.parseWebhook(body, new Headers())).toThrow(CourierWebhookVerificationError);
  });
});

describe("spec sheet and label PDFs", () => {
  async function previewPng() {
    return sharp({ create: { width: 300, height: 390, channels: 3, background: "#1f6f50" } }).png().toBuffer();
  }

  const base: Omit<SpecSheetData, "previewPng"> = {
    orderNumber: "CS-20261009-ABCDE",
    itemId: "11111111-2222-4333-8444-555555555555",
    paidAt: new Date("2026-10-09T08:00:00Z"),
    kind: "CUSTOM_DESIGN",
    productName: "Linen Wrap Dress",
    size: "M",
    quantity: 1,
    colorName: null,
    parts: [{ region: "Skirt", color: "Emerald (#1f6f50)", pattern: "Polka dots in White (#f5f5f0)" }],
    styleOptions: [{ group: "Neckline", option: "Square" }],
    layers: [{ area: "Front chest", description: 'Text "Ava 2026" - Dancing Script, White (#f5f5f0)' }],
    printFiles: [{ areaId: "front-chest", label: "Front chest", key: "x/orders/abcdef12.png", widthPx: 2362, heightPx: 1772, widthCm: 20, heightCm: 15 }],
    referencePng: null,
    customerNote: "Please make the hem 2 cm shorter — thank you!",
    adminUrl: "http://localhost:3000/admin/orders/x",
  };

  it("contains everything the workshop needs", async () => {
    const text = pdfText(await buildSpecSheet({ ...base, previewPng: await previewPng() }));
    for (const expected of ["CS-20261009-ABCDE", "Linen Wrap Dress", "Square", "Emerald (#1f6f50)", "Polka dots", "Front chest", "2362 x 1772 px", "20 x 15 cm", 'Text "Ava 2026"', "hem 2 cm shorter - thank you!"]) {
      expect(text).toContain(expected);
    }
  });

  it("never contains customer contact details", async () => {
    const text = pdfText(await buildSpecSheet({ ...base, previewPng: null }));
    for (const forbidden of ["01712345678", "Dhanmondi", "Ava Rahman", "@"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).toContain("no customer contact details");
  });

  it("puts the delivery details on the label", async () => {
    const text = pdfText(
      await buildShippingLabel({
        carrier: "Mock Courier",
        trackingNumber: "MCK2222222222",
        orderNumber: "CS-20261009-ABCDE",
        recipient: { name: "Ava Rahman", line1: "House 12, Road 5, Dhanmondi", line2: null, city: "Dhaka", postalCode: "1205", phone: "01712345678" },
      }),
    );
    for (const expected of ["MOCK COURIER", "MCK2222222222", "Ava Rahman", "Dhanmondi", "Dhaka 1205", "01712345678"]) {
      expect(text).toContain(expected);
    }
  });
});
