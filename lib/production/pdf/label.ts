import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import QRCode from "qrcode";

import { pdfSafe, wrapText } from "./text";

// 4×6 inch shipping label placeholder: exactly the recipient details a courier needs.

export type LabelData = {
  carrier: string;
  trackingNumber: string;
  orderNumber: string;
  recipient: { name: string; line1: string; line2: string | null; city: string; postalCode: string | null; phone: string };
};

const SIZE = { width: 288, height: 432 };

export async function buildShippingLabel(data: LabelData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Label ${data.trackingNumber}`);
  doc.setProducer("ClothSeeker");
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([SIZE.width, SIZE.height]);
  const ink = rgb(0, 0, 0);
  const x = 18;
  let y = SIZE.height - 30;

  page.drawText(pdfSafe(data.carrier.toUpperCase()), { x, y, size: 16, font: bold, color: ink });
  page.drawText("PLACEHOLDER - NOT VALID FOR REAL SHIPPING", { x, y: y - 14, size: 7, font: regular, color: rgb(0.7, 0, 0) });
  y -= 40;
  page.drawText(pdfSafe(data.trackingNumber), { x, y, size: 18, font: bold, color: ink });
  const qr = await doc.embedPng(await QRCode.toBuffer(data.trackingNumber, { type: "png", margin: 1, width: 200 }));
  page.drawImage(qr, { x: SIZE.width - 18 - 80, y: y - 50, width: 80, height: 80 });
  y -= 70;

  page.drawText("TO", { x, y, size: 9, font: bold, color: ink });
  const r = data.recipient;
  const lines = [r.name, r.line1, ...(r.line2 ? [r.line2] : []), `${r.city}${r.postalCode ? ` ${r.postalCode}` : ""}`, `Mobile: ${r.phone}`];
  for (const line of lines) {
    for (const wrapped of wrapText(line, regular, 12, SIZE.width - 36)) {
      y -= 16;
      page.drawText(wrapped, { x, y, size: 12, font: regular, color: ink });
    }
  }
  y -= 30;
  page.drawText("FROM", { x, y, size: 9, font: bold, color: ink });
  y -= 14;
  page.drawText("ClothSeeker, Dhaka, Bangladesh", { x, y, size: 10, font: regular, color: ink });
  y -= 24;
  page.drawText(pdfSafe(`Order ${data.orderNumber}`), { x, y, size: 10, font: regular, color: ink });
  return doc.save();
}
