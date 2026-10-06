import { safeHex } from "./svg-color";

// Curated pattern library. Templates allow a subset by id. The same SVG is rendered by the
// browser preview and the server renderer, so patterns look identical in both.

export const PATTERN_IDS = ["stripes", "polka-dots", "gingham", "floral", "plaid", "chevron"] as const;
export type PatternId = (typeof PATTERN_IDS)[number];

const PATTERN_LABELS: Record<PatternId, string> = {
  stripes: "Stripes",
  "polka-dots": "Polka dots",
  gingham: "Gingham",
  floral: "Floral",
  plaid: "Plaid",
  chevron: "Chevron",
};

export const PATTERNS = PATTERN_IDS.map((id) => ({ id, label: PATTERN_LABELS[id] }));

/** Tile content for a 40×40 unit cell. `fg` draws on top of the region's base color `bg`. */
function tile(id: PatternId, fg: string, bg: string): string {
  switch (id) {
    case "stripes":
      return `<rect width="40" height="40" fill="${bg}"/><rect width="20" height="40" fill="${fg}"/>`;
    case "polka-dots":
      return `<rect width="40" height="40" fill="${bg}"/><circle cx="10" cy="10" r="6" fill="${fg}"/><circle cx="30" cy="30" r="6" fill="${fg}"/>`;
    case "gingham":
      return `<rect width="40" height="40" fill="${bg}"/><rect width="20" height="40" fill="${fg}" fill-opacity="0.5"/><rect width="40" height="20" fill="${fg}" fill-opacity="0.5"/>`;
    case "floral":
      return (
        `<rect width="40" height="40" fill="${bg}"/>` +
        `<g fill="${fg}" transform="translate(20 20)">` +
        [0, 72, 144, 216, 288].map((a) => `<ellipse rx="4" ry="8" cy="-8" transform="rotate(${a})"/>`).join("") +
        `</g><circle cx="20" cy="20" r="3.5" fill="${bg}"/>`
      );
    case "plaid":
      return (
        `<rect width="40" height="40" fill="${bg}"/>` +
        `<rect y="6" width="40" height="8" fill="${fg}" fill-opacity="0.45"/><rect x="6" width="8" height="40" fill="${fg}" fill-opacity="0.45"/>` +
        `<rect y="28" width="40" height="2" fill="${fg}" fill-opacity="0.8"/><rect x="28" width="2" height="40" fill="${fg}" fill-opacity="0.8"/>`
      );
    case "chevron":
      return `<rect width="40" height="40" fill="${bg}"/><path d="M0 14 L20 2 L40 14 M0 34 L20 22 L40 34" fill="none" stroke="${fg}" stroke-width="6"/>`;
  }
}

/**
 * A width×height SVG filled with the pattern. `cell` is the tile size in output pixels,
 * so patterns keep a sensible scale at any resolution.
 */
export function patternSvg(id: PatternId, fgColor: string, bgColor: string, width: number, height: number, cell: number): string {
  const fg = safeHex(fgColor);
  const bg = safeHex(bgColor);
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const c = Math.max(4, Math.round(cell));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs><pattern id="p" width="${c}" height="${c}" patternUnits="userSpaceOnUse">` +
    `<g transform="scale(${c / 40})">${tile(id, fg, bg)}</g></pattern></defs>` +
    `<rect width="${w}" height="${h}" fill="url(#p)"/></svg>`
  );
}
