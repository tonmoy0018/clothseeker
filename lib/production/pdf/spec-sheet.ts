import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import QRCode from "qrcode";

import type { StoredPrintFile } from "@/lib/orders/print-files";

import { pdfSafe, wrapText } from "./text";

// Production spec sheet (A4). Deliberately contains NO customer contact data — no name, address,
// phone or email: the workshop only needs what to make. The shipping label is a separate document.

export type SpecSheetData = {
  orderNumber: string;
  itemId: string;
  paidAt: Date | null;
  kind: "READY_MADE" | "CUSTOM_DESIGN" | "QUOTE";
  productName: string;
  size: string;
  quantity: number;
  colorName: string | null;
  parts: { region: string; color: string; pattern: string | null }[];
  styleOptions: { group: string; option: string }[];
  layers: { area: string; description: string }[];
  printFiles: StoredPrintFile[];
  previewPng: Buffer | null;
  referencePng: Buffer | null;
  customerNote: string | null;
  /** Admin page for this order; encoded in the QR code. */
  adminUrl: string;
};

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 40;
const INK = rgb(0.1, 0.1, 0.1);
const MUTED = rgb(0.42, 0.42, 0.42);

type Fonts = { regular: PDFFont; bold: PDFFont };

class Cursor {
  y: number;

  constructor(
    private readonly page: PDFPage,
    private readonly fonts: Fonts,
    private readonly x: number,
    top: number,
    private readonly width: number,
  ) {
    this.y = top;
  }

  heading(text: string) {
    this.y -= 18;
    this.page.drawText(pdfSafe(text), { x: this.x, y: this.y, size: 11, font: this.fonts.bold, color: INK });
    this.y -= 4;
  }

  row(label: string, value: string) {
    this.y -= 14;
    this.page.drawText(pdfSafe(label), { x: this.x, y: this.y, size: 9, font: this.fonts.regular, color: MUTED });
    const lines = wrapText(value, this.fonts.regular, 10, this.width - 110);
    lines.forEach((line, i) => {
      if (i > 0) this.y -= 12;
      this.page.drawText(line, { x: this.x + 110, y: this.y, size: 10, font: this.fonts.regular, color: INK });
    });
  }

  line(text: string, size = 10) {
    for (const line of wrapText(text, this.fonts.regular, size, this.width)) {
      this.y -= size + 3;
      this.page.drawText(line, { x: this.x, y: this.y, size, font: this.fonts.regular, color: INK });
    }
  }
}

async function qrPng(text: string): Promise<Buffer> {
  return QRCode.toBuffer(text, { type: "png", margin: 1, width: 240, errorCorrectionLevel: "M" });
}

export async function buildSpecSheet(data: SpecSheetData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Spec sheet ${data.orderNumber}`);
  doc.setProducer("ClothSeeker");
  doc.setCreator("ClothSeeker");
  const fonts = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
  const page = doc.addPage([A4.width, A4.height]);

  // Header
  page.drawText("ClothSeeker - Production spec sheet", { x: MARGIN, y: A4.height - MARGIN - 12, size: 16, font: fonts.bold, color: INK });
  page.drawText(pdfSafe(`Order ${data.orderNumber}   Item ${data.itemId.slice(0, 8)}`), {
    x: MARGIN,
    y: A4.height - MARGIN - 30,
    size: 10,
    font: fonts.regular,
    color: MUTED,
  });
  if (data.paidAt) {
    page.drawText(pdfSafe(`Paid ${data.paidAt.toISOString().slice(0, 10)}`), { x: MARGIN, y: A4.height - MARGIN - 43, size: 10, font: fonts.regular, color: MUTED });
  }

  // QR code (top right) → admin order page
  const qr = await doc.embedPng(await qrPng(data.adminUrl));
  page.drawImage(qr, { x: A4.width - MARGIN - 72, y: A4.height - MARGIN - 72, width: 72, height: 72 });

  // Approved design (left column)
  const imageTop = A4.height - MARGIN - 70;
  const imageBox = { width: 220, height: 286 };
  if (data.previewPng) {
    const preview = await doc.embedPng(data.previewPng);
    const scale = Math.min(imageBox.width / preview.width, imageBox.height / preview.height);
    page.drawRectangle({ x: MARGIN, y: imageTop - imageBox.height, ...imageBox, borderColor: rgb(0.85, 0.85, 0.85), borderWidth: 1 });
    page.drawImage(preview, {
      x: MARGIN + (imageBox.width - preview.width * scale) / 2,
      y: imageTop - imageBox.height + (imageBox.height - preview.height * scale) / 2,
      width: preview.width * scale,
      height: preview.height * scale,
    });
    page.drawText("Approved design", { x: MARGIN, y: imageTop - imageBox.height - 12, size: 8, font: fonts.regular, color: MUTED });
  }

  // Details (right column)
  const right = new Cursor(page, fonts, data.previewPng ? MARGIN + imageBox.width + 20 : MARGIN, imageTop, data.previewPng ? A4.width - MARGIN * 2 - imageBox.width - 20 : A4.width - MARGIN * 2);
  right.heading("Garment");
  right.row("Product", data.productName);
  right.row("Type", data.kind === "READY_MADE" ? "Ready-made" : data.kind === "QUOTE" ? "Quoted special tailoring" : "Custom design (made to order)");
  right.row("Size", data.size);
  right.row("Quantity", String(data.quantity));
  if (data.colorName) right.row("Colour", data.colorName);
  if (data.styleOptions.length > 0) {
    right.heading("Style options");
    for (const s of data.styleOptions) right.row(s.group, s.option);
  }
  if (data.parts.length > 0) {
    right.heading("Colours per part");
    for (const p of data.parts) right.row(p.region, p.pattern ? `${p.color} with ${p.pattern}` : p.color);
  }

  // Full-width sections below the image
  const below = new Cursor(page, fonts, MARGIN, Math.min(right.y, imageTop - imageBox.height - 20) - 6, A4.width - MARGIN * 2);
  if (data.layers.length > 0) {
    below.heading("Placements");
    for (const l of data.layers) below.row(l.area, l.description);
  }
  if (data.printFiles.length > 0) {
    below.heading("Print files (300 DPI, transparent PNG)");
    for (const f of data.printFiles) {
      below.row(f.label, `${f.widthCm} x ${f.heightCm} cm  -  ${f.widthPx} x ${f.heightPx} px  -  file ${f.key.split("/").pop()?.slice(0, 8) ?? ""}`);
    }
  }
  if (data.referencePng) {
    below.heading("Customer reference photo");
    const ref = await doc.embedPng(data.referencePng);
    const scale = Math.min(140 / ref.width, 140 / ref.height);
    below.y -= ref.height * scale + 4;
    page.drawImage(ref, { x: MARGIN, y: below.y, width: ref.width * scale, height: ref.height * scale });
  }
  below.heading("Customer note");
  below.line(data.customerNote?.trim() ? data.customerNote : "None");

  page.drawText("This sheet intentionally contains no customer contact details. Scan the QR code to open the order.", {
    x: MARGIN,
    y: MARGIN - 10,
    size: 7,
    font: fonts.regular,
    color: MUTED,
  });
  return doc.save();
}
