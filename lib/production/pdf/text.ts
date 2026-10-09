import type { PDFFont } from "pdf-lib";

// The standard PDF fonts (Helvetica) only cover WinAnsi (Latin-1-ish) characters.

const REPLACEMENTS: [RegExp, string][] = [
  [/৳/g, "BDT "],
  [/[‘’]/g, "'"],
  [/[“”]/g, '"'],
  [/[–—]/g, "-"],
  [/…/g, "..."],
  [/×/g, "x"],
  [/·/g, "-"],
];

/** Text safe for the standard fonts: known symbols mapped, other unsupported characters → "?". */
export function pdfSafe(value: string): string {
  let text = value;
  for (const [pattern, replacement] of REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[^ -ÿ]/g, "?");
}

/** Greedy word wrap to a maximum width. */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of pdfSafe(text).split(/\s*\n\s*/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}
