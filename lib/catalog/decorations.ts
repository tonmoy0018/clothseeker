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

// ─── customised decorations ──────────────────────────────────────────────────
// A second colour for a shape's details, outline-only drawing, mirroring, and a row of repeats (a
// border that can curve, e.g. along a neckline or hem). Pure SVG, shared by the server renderer, the
// print files and the design screen, so all three draw the same thing. A decoration without any of these
// settings keeps the plain `decorationSvg` look exactly.

/** Each shape's main body and, where it has one, a detail that can take a second colour. */
const PARTS: Record<DecorationId, { main: string; detail: string | null; detailIsLine: boolean }> = {
  star: { main: SHAPES.star, detail: null, detailIsLine: false },
  heart: { main: SHAPES.heart, detail: null, detailIsLine: false },
  flower: {
    main: `<g transform="translate(50 50)">${[0, 60, 120, 180, 240, 300].map((a) => `<ellipse rx="14" ry="26" cy="-22" transform="rotate(${a})"/>`).join("")}</g>`,
    detail: `<circle cx="50" cy="50" r="12"/>`,
    detailIsLine: false,
  },
  bow: {
    main: `<path d="M50 50 L10 22 C4 18 2 24 2 30 L2 70 C2 76 4 82 10 78 Z M50 50 L90 22 C96 18 98 24 98 30 L98 70 C98 76 96 82 90 78 Z"/>`,
    detail: `<circle cx="50" cy="50" r="11"/>`,
    detailIsLine: false,
  },
  sparkle: { main: SHAPES.sparkle, detail: null, detailIsLine: false },
  butterfly: {
    main: `<path d="M48 50 C30 18 4 14 6 36 C8 52 26 54 44 52 C26 58 12 72 22 86 C32 96 46 76 48 56 Z M52 50 C70 18 96 14 94 36 C92 52 74 54 56 52 C74 58 88 72 78 86 C68 96 54 76 52 56 Z"/>`,
    detail: `<rect x="47" y="30" width="6" height="44" rx="3"/>`,
    detailIsLine: false,
  },
  leaf: { main: `<path d="M12 88 C12 40 40 10 92 8 C90 60 60 88 12 88 Z"/>`, detail: `<path d="M14 86 L70 30"/>`, detailIsLine: true },
  moon: { main: SHAPES.moon, detail: null, detailIsLine: false },
};

/** Whether a shape has a detail that can take a second colour (flower centre, bow knot, butterfly body, leaf vein). */
export function hasDetail(id: DecorationId): boolean {
  return PARTS[id].detail !== null;
}

export const OUTLINE_WIDTH = { min: 2, max: 14, default: 6 } as const;
export const REPEAT_COUNT = { min: 2, max: 24 } as const;

/** How a decoration is drawn (all optional: none set = the plain look). */
export type DecorationLook = {
  color: string;
  /** Colour of the shape's detail (see `hasDetail`). */
  detail?: string;
  style?: "filled" | "outline";
  /** Outline thickness in the shape's 100-unit design space. */
  outline?: number;
  mirror?: boolean;
};

/** A row of repeats across the item's box; `curve` bends it: > 0 sags in the middle (a U), < 0 arches. */
export type DecorationRepeat = { count: number; curve: number };

/** True when the plain single-colour look applies (so the old, exact drawing is used). */
export function isPlainDecoration(look: DecorationLook, repeat: DecorationRepeat | null | undefined): boolean {
  return !repeat && !look.detail && (look.style ?? "filled") === "filled" && !look.mirror;
}

/** One motif in the 100×100 design space. */
function motif(id: DecorationId, look: DecorationLook): string {
  const parts = PARTS[id];
  const color = safeHex(look.color);
  const detail = safeHex(look.detail ?? look.color);
  const outline = look.style === "outline";
  const width = Math.min(OUTLINE_WIDTH.max, Math.max(OUTLINE_WIDTH.min, look.outline ?? OUTLINE_WIDTH.default));
  const body = outline
    ? `<g fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round">${parts.main}</g>`
    : `<g fill="${color}">${parts.main}</g>`;
  let extra = "";
  if (parts.detail) {
    const hasOwnColour = look.detail !== undefined;
    if (parts.detailIsLine) {
      const stroke = hasOwnColour ? `stroke="${detail}"` : `stroke="#ffffff" stroke-opacity="0.6"`;
      extra = `<g fill="none" ${stroke} stroke-width="${outline ? width : 3}" stroke-linecap="round">${parts.detail}</g>`;
    } else if (outline) {
      extra = `<g fill="none" stroke="${detail}" stroke-width="${width}">${parts.detail}</g>`;
    } else {
      extra = hasOwnColour || id !== "flower" ? `<g fill="${detail}">${parts.detail}</g>` : `<g fill="#ffffff" fill-opacity="0.6">${parts.detail}</g>`;
    }
  }
  const drawing = body + extra;
  return look.mirror ? `<g transform="translate(100 0) scale(-1 1)">${drawing}</g>` : drawing;
}

/** Share of a border box's height left for the curve at full curve (the rest is the motif's size). */
export const CURVE_ROOM = 0.65;

/** A border's motif size for its box height and curve. */
export function borderMotifSize(boxHeight: number, curve: number): number {
  return boxHeight * (1 - CURVE_ROOM * Math.min(1, Math.abs(curve)));
}

/** Where each repeat goes in a width×height box (centres, side length, tilt in degrees). Pure. */
export function repeatLayout(count: number, curve: number, width: number, height: number): { x: number; y: number; size: number; angle: number }[] {
  const n = Math.max(1, Math.round(count));
  const c = Math.min(1, Math.max(-1, curve));
  const size = Math.max(1, Math.min(borderMotifSize(height, c), width / n));
  const sag = c * ((height - size) / 2);
  return Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const run = Math.max(1, width - size);
    const slope = (sag * (8 - 16 * t)) / run;
    return { x: size / 2 + t * (width - size), y: height / 2 + sag * (8 * t * (1 - t) - 1), size, angle: (Math.atan(slope) * 180) / Math.PI };
  });
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * A decoration item as an SVG of exactly width×height: one motif centred, or a row of repeats. Outline
 * drawings get a little room so the stroke isn't cut at the shape's edge.
 */
export function decorationLayerSvg(id: DecorationId, look: DecorationLook, repeat: DecorationRepeat | null | undefined, width: number, height: number): string {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const inset = look.style === "outline" ? 0.88 : 1;
  const one = motif(id, look);
  const place = (cx: number, cy: number, size: number, angle: number) => {
    const s = size * inset;
    return `<g transform="translate(${r2(cx)} ${r2(cy)}) rotate(${r2(angle)}) scale(${r2(s / 100)}) translate(-50 -50)">${one}</g>`;
  };
  const items = repeat ? repeatLayout(repeat.count, repeat.curve, w, h).map((p) => place(p.x, p.y, p.size, p.angle)) : [place(w / 2, h / 2, Math.min(w, h), 0)];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${items.join("")}</svg>`;
}

/** How many motifs a decoration item prints (a border counts each repeat). */
export function motifCount(repeat: DecorationRepeat | null | undefined): number {
  return repeat ? Math.max(1, Math.round(repeat.count)) : 1;
}

/**
 * The item's box (fractions of its area) for a border of `count` repeats spaced `spacing` × the motif
 * size apart, keeping its centre and its motif size (the box grows taller to make room for a curve),
 * shrinking to fit inside the area (or within `maxWidthShare` of its width: areas that span more than the
 * garment, e.g. a whole front trimmed to the fabric, keep borders on the fabric). `previousCurve` is the
 * curve the box was made for; `areaCm` converts fractions to real proportions.
 */
export function borderBox(
  box: { x: number; y: number; w: number; h: number },
  areaCm: { width: number; height: number },
  count: number,
  spacing: number,
  curve: number,
  previousCurve = curve,
  maxWidthShare = 1,
): { x: number; y: number; w: number; h: number } {
  const n = Math.max(1, Math.round(count));
  const motifCm = borderMotifSize(box.h * areaCm.height, previousCurve);
  let widthCm = motifCm * (n + (n - 1) * Math.max(0, spacing));
  let heightCm = motifCm / (1 - CURVE_ROOM * Math.min(1, Math.abs(curve)));
  if (heightCm > areaCm.height) {
    widthCm *= areaCm.height / heightCm;
    heightCm = areaCm.height;
  }
  let h = heightCm / areaCm.height;
  // Too wide: make everything smaller in proportion.
  const maxWidthCm = areaCm.width * Math.min(1, Math.max(0.1, maxWidthShare));
  if (widthCm > maxWidthCm) {
    const shrink = maxWidthCm / widthCm;
    widthCm *= shrink;
    h *= shrink;
  }
  const w = Math.min(1, widthCm / areaCm.width);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const r4 = (v: number) => Math.round(v * 10_000) / 10_000;
  return { x: r4(Math.min(Math.max(cx - w / 2, 0), 1 - w)), y: r4(Math.min(Math.max(cy - h / 2, 0), 1 - h)), w: r4(w), h: r4(h) };
}

/** The spacing (× motif size) a border box currently has: the inverse of `borderBox`. */
export function borderSpacing(box: { w: number; h: number }, areaCm: { width: number; height: number }, count: number, curve: number): number {
  const n = Math.max(2, Math.round(count));
  const motifCm = borderMotifSize(box.h * areaCm.height, curve);
  if (motifCm <= 0) return 0;
  return Math.max(0, ((box.w * areaCm.width) / motifCm - n) / (n - 1));
}
