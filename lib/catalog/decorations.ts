import { safeHex } from "./svg-color";

// Curated, single-color decorations (no customer-supplied SVG anywhere). viewBox 0 0 100 100.

const SHAPES = {
  star: `<path d="M50 6 L62 38 L96 38 L68 58 L79 92 L50 71 L21 92 L32 58 L4 38 L38 38 Z"/>`,
  heart: `<path d="M50 88 C20 66 6 48 6 30 C6 16 17 6 30 6 C39 6 46 11 50 18 C54 11 61 6 70 6 C83 6 94 16 94 30 C94 48 80 66 50 88 Z"/>`,
  flower: `<g transform="translate(50 50)">${[0, 60, 120, 180, 240, 300]
    .map((a) => `<ellipse rx="14" ry="26" cy="-22" transform="rotate(${a})"/>`)
    .join("")}</g><circle cx="50" cy="50" r="12" fill="#ffffff" fill-opacity="0.6"/>`,
  bow: `<path d="M50 50 L10 22 C4 18 2 24 2 30 L2 70 C2 76 4 82 10 78 Z M50 50 L90 22 C96 18 98 24 98 30 L98 70 C98 76 96 82 90 78 Z"/><circle cx="50" cy="50" r="11"/>`,
  sparkle: `<path d="M50 2 C54 34 66 46 98 50 C66 54 54 66 50 98 C46 66 34 54 2 50 C34 46 46 34 50 2 Z"/>`,
  butterfly: `<path d="M48 50 C30 18 4 14 6 36 C8 52 26 54 44 52 C26 58 12 72 22 86 C32 96 46 76 48 56 Z M52 50 C70 18 96 14 94 36 C92 52 74 54 56 52 C74 58 88 72 78 86 C68 96 54 76 52 56 Z"/><rect x="47" y="30" width="6" height="44" rx="3"/>`,
  leaf: `<path d="M12 88 C12 40 40 10 92 8 C90 60 60 88 12 88 Z"/><path d="M14 86 L70 30" stroke="#ffffff" stroke-opacity="0.6" stroke-width="3" fill="none"/>`,
  moon: `<path d="M64 6 C40 12 24 32 24 54 C24 78 44 96 68 96 C80 96 90 92 96 86 C88 90 80 92 72 92 C48 92 30 74 30 50 C30 30 44 12 64 6 Z"/>`,
} as const;

export const DECORATION_IDS = ["star", "heart", "flower", "bow", "sparkle", "butterfly", "leaf", "moon"] as const;
export type DecorationId = (typeof DECORATION_IDS)[number];

const DECORATION_LABELS: Record<DecorationId, string> = {
  star: "Star",
  heart: "Heart",
  flower: "Flower",
  bow: "Bow",
  sparkle: "Sparkle",
  butterfly: "Butterfly",
  leaf: "Leaf",
  moon: "Moon",
};

export const DECORATIONS = DECORATION_IDS.map((id) => ({ id, label: DECORATION_LABELS[id] }));

/** Decoration as a square SVG of `size` px in the given color. */
export function decorationSvg(id: DecorationId, color: string, size = 100): string {
  const fill = safeHex(color);
  const s = Math.max(1, Math.round(size));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 100 100"><g fill="${fill}">${SHAPES[id]}</g></svg>`;
}
