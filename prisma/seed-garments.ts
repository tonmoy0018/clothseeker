import sharp from "sharp";

// Garment pictures and matching region masks for the seeded dresses: one picture per style choice
// (neckline × sleeves × length), so the design preview changes shape like a real tailoring configurator.
// Our own trusted SVG (never user input), rasterized at 1200×1560. The fabric is drawn near-white with
// soft folds and shadows: the renderer multiplies colours onto it, so the shading shows through.
// Masks reuse the exact same shapes (without shading), so every region lines up with the picture.

export type Side = "front" | "back";
export type GarmentStyle = { neckline: string; sleeveLength: string; dressLength: string };

export type SeedRegion = "straps" | "bodice" | "skirt";
export const SEED_REGIONS: readonly { id: SeedRegion; label: string }[] = [
  { id: "straps", label: "Sleeves & straps" },
  { id: "bodice", label: "Bodice" },
  { id: "skirt", label: "Skirt" },
];

/** Option ids of the default template (lib/catalog/default-template.ts) that have their own drawing. */
export const SEED_STYLE_IDS = {
  neckline: ["round", "v-neck", "square"],
  sleeveLength: ["sleeveless", "short", "long"],
  dressLength: ["mini", "midi", "maxi"],
} as const;

export const BACKGROUND = "#f3f2ef";

/**
 * The default template's skirt print area reaches lower than a mini hem, so seeded templates use a
 * slightly shorter one that every length covers (checked by tests/unit/seed-garments.test.ts).
 */
export const SEED_SKIRT_AREA = { rect: { x: 0.32, y: 0.5, w: 0.36, h: 0.27 }, heightCm: 27 } as const;
const VIEW_W = 200;
const VIEW_H = 260;
export const GARMENT_WIDTH = 1200;

/** Above this line (viewBox units) the bodice counts as shoulder straps. */
const STRAP_LINE = 30;
const HEM_Y: Record<string, number> = { mini: 204, midi: 230, maxi: 254 };

// ─── shapes ──────────────────────────────────────────────────────────────────

function neckline(side: Side, id: string): string {
  if (side === "back") {
    return "C 90 26 110 26 114 16";
  }
  switch (id) {
    case "v-neck":
      return "L 100 48 L 114 16";
    case "square":
      return "L 87 38 L 113 38 L 114 16";
    default:
      return "C 88 36 112 36 114 16";
  }
}

function bodicePath(side: Side, style: GarmentStyle): string {
  return (
    `M 70 22 L 86 16 ${neckline(side, style.neckline)} L 130 22 Q 128 44 133 58 Q 130 80 125 104 ` +
    "Q 100 109 75 104 Q 70 80 67 58 Q 72 44 70 22 Z"
  );
}

function hemY(style: GarmentStyle): number {
  return HEM_Y[style.dressLength] ?? HEM_Y.midi ?? 232;
}

/** Half the hem width: the skirt flares from the hips (y 134, ±39) at a steady angle. */
function hemHalfWidth(y: number): number {
  return 39 + (y - 134) * 0.3;
}

/** Wavy hem from the right hem point to the left one, so the skirt reads as soft folds. */
function hemSegments(y: number): string {
  const half = hemHalfWidth(y);
  const steps = 8;
  let d = "";
  for (let k = 0; k < steps; k += 1) {
    const x0 = 100 + half - (2 * half * k) / steps;
    const x1 = 100 + half - (2 * half * (k + 1)) / steps;
    d += `Q ${((x0 + x1) / 2).toFixed(2)} ${(y + (k % 2 === 0 ? 3.5 : -1.5)).toFixed(2)} ${x1.toFixed(2)} ${y} `;
  }
  return d;
}

function skirtPath(style: GarmentStyle): string {
  const y = hemY(style);
  const half = hemHalfWidth(y);
  return (
    `M 75 104 Q 100 109 125 104 C 132 114 137 124 139 134 L ${(100 + half).toFixed(2)} ${y} ${hemSegments(y)}` +
    "L 61 134 C 63 124 68 114 75 104 Z"
  );
}

/** Left sleeve; the right one is its mirror image. Empty when sleeveless. */
function leftSleevePath(style: GarmentStyle): string {
  switch (style.sleeveLength) {
    case "short":
      return "M 70 22 Q 57 26 50 50 Q 55 56 61 62 Q 64 58 67 58 Q 72 44 70 22 Z";
    case "long":
      return "M 70 22 Q 56 30 52 64 L 45 146 Q 51 149 57 149 L 63 80 Q 65 64 67 58 Q 72 44 70 22 Z";
    default:
      return "";
  }
}

const MIRROR = `transform="translate(${VIEW_W} 0) scale(-1 1)"`;

function sleeves(style: GarmentStyle, attrs: string): string {
  const d = leftSleevePath(style);
  return d ? `<path d="${d}" ${attrs}/><path d="${d}" ${attrs} ${MIRROR}/>` : "";
}

function svgOpen(width: number): string {
  const height = Math.round((width * VIEW_H) / VIEW_W);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_W} ${VIEW_H}" width="${width}" height="${height}">`;
}

// ─── garment picture ─────────────────────────────────────────────────────────

const FABRIC = "#f6f6f4";
const EDGE = 'fill="none" stroke="#a7a7a2" stroke-width="0.7" stroke-linejoin="round"';
const SEAM = 'fill="none" stroke="#c4c4bf" stroke-width="0.6"';
const STITCH = 'fill="none" stroke="#bdbdb8" stroke-width="0.35" stroke-dasharray="1.2 1"';

/** Soft vertical folds fanning from the hips to the hem: dark creases with highlights between them. */
function skirtFolds(style: GarmentStyle): string {
  const y = hemY(style);
  const half = hemHalfWidth(y);
  const count = 9;
  let shapes = "";
  for (let i = 1; i < count; i += 1) {
    const top = 72 + (i * 56) / count;
    const bottom = 100 - half + (i * 2 * half) / count;
    const spread = 2.6 + (y - 200) * 0.02;
    shapes += `<path d="M ${top - 0.4} 108 L ${top + 0.4} 108 L ${bottom + spread} ${y + 3} L ${bottom - spread} ${y + 3} Z" fill="#000" opacity="0.11"/>`;
    const mid = bottom + half / count;
    const midTop = top + 28 / count;
    shapes += `<path d="M ${midTop - 0.3} 110 L ${midTop + 0.3} 110 L ${mid + spread * 0.8} ${y + 3} L ${mid - spread * 0.8} ${y + 3} Z" fill="#fff" opacity="0.6"/>`;
  }
  return `<g filter="url(#soft)" clip-path="url(#skirtClip)">${shapes}</g>`;
}

function garmentSvg(side: Side, style: GarmentStyle, width: number): string {
  const bodice = bodicePath(side, style);
  const skirt = skirtPath(style);
  const y = hemY(style);
  const half = hemHalfWidth(y);
  const sleeveD = leftSleevePath(style);

  const defs =
    "<defs>" +
    '<filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="1.4"/></filter>' +
    '<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3"/></filter>' +
    // Round body: darker towards the sides, brightest in the middle.
    `<linearGradient id="bodiceShade" gradientUnits="userSpaceOnUse" x1="66" y1="0" x2="134" y2="0">` +
    '<stop offset="0" stop-color="#000" stop-opacity="0.16"/><stop offset="0.22" stop-color="#000" stop-opacity="0.02"/>' +
    '<stop offset="0.5" stop-color="#fff" stop-opacity="0.5"/><stop offset="0.78" stop-color="#000" stop-opacity="0.02"/>' +
    '<stop offset="1" stop-color="#000" stop-opacity="0.18"/></linearGradient>' +
    `<linearGradient id="skirtShade" gradientUnits="userSpaceOnUse" x1="${100 - half}" y1="0" x2="${100 + half}" y2="0">` +
    '<stop offset="0" stop-color="#000" stop-opacity="0.15"/><stop offset="0.25" stop-color="#000" stop-opacity="0"/>' +
    '<stop offset="0.75" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.17"/></linearGradient>' +
    // Shadow just under the waist seam, fading down the skirt.
    `<linearGradient id="waistShade" gradientUnits="userSpaceOnUse" x1="0" y1="104" x2="0" y2="130">` +
    '<stop offset="0" stop-color="#000" stop-opacity="0.12"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient>' +
    '<radialGradient id="bust"><stop offset="0" stop-color="#fff" stop-opacity="0.45"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>' +
    `<linearGradient id="sleeveShade" gradientUnits="userSpaceOnUse" x1="44" y1="0" x2="70" y2="0">` +
    '<stop offset="0" stop-color="#000" stop-opacity="0.14"/><stop offset="0.45" stop-color="#fff" stop-opacity="0.35"/>' +
    '<stop offset="1" stop-color="#000" stop-opacity="0.16"/></linearGradient>' +
    `<clipPath id="skirtClip"><path d="${skirt}"/></clipPath>` +
    `<clipPath id="bodiceClip"><path d="${bodice}"/></clipPath>` +
    "</defs>";

  // A soft shadow behind the garment lifts it off the background (outside every mask).
  const shadow =
    `<g filter="url(#shadow)" opacity="0.18" transform="translate(1.5 2.5)">` +
    `<path d="${skirt}" fill="#000"/><path d="${bodice}" fill="#000"/>${sleeves(style, 'fill="#000"')}</g>`;

  const skirtLayer =
    `<path d="${skirt}" fill="${FABRIC}"/>` +
    `<path d="${skirt}" fill="url(#skirtShade)"/>` +
    `<path d="${skirt}" fill="url(#waistShade)"/>` +
    skirtFolds(style) +
    // Hem topstitching.
    `<path d="M ${(100 + hemHalfWidth(y - 3)).toFixed(2)} ${y - 3} ${hemSegments(y - 3)}" ${STITCH} clip-path="url(#skirtClip)"/>` +
    (side === "back" ? `<path d="M 100 107 L 100 ${y}" ${SEAM}/>` : "") +
    `<path d="${skirt}" ${EDGE}/>`;

  const bodiceDetails =
    side === "front"
      ? // Bust highlights, the shadow beneath them and two waist darts.
        '<ellipse cx="88" cy="62" rx="11" ry="9" fill="url(#bust)"/><ellipse cx="112" cy="62" rx="11" ry="9" fill="url(#bust)"/>' +
        '<ellipse cx="100" cy="76" rx="26" ry="3" fill="#000" opacity="0.05" filter="url(#soft)"/>' +
        `<path d="M 88 105 L 89 80" ${SEAM}/><path d="M 112 105 L 111 80" ${SEAM}/>`
      : // Centre-back zip.
        `<path d="M 100 24 L 100 106" ${SEAM}/><path d="M 101.4 26 L 101.4 98" ${STITCH}/><path d="M 98.6 26 L 98.6 98" ${STITCH}/>`;

  const bodiceLayer =
    `<path d="${bodice}" fill="${FABRIC}"/>` +
    `<path d="${bodice}" fill="url(#bodiceShade)"/>` +
    `<g clip-path="url(#bodiceClip)">${bodiceDetails}` +
    // Shoulder seams where the straps join the bodice.
    `<path d="M 66 ${STRAP_LINE} L 134 ${STRAP_LINE}" ${STITCH}/></g>` +
    `<path d="M 86 16 ${neckline(side, style.neckline)}" fill="none" stroke="#b7b7b2" stroke-width="1"/>` +
    `<path d="${bodice}" ${EDGE}/>` +
    `<path d="M 75 104 Q 100 109 125 104" fill="none" stroke="#b9b9b4" stroke-width="0.9"/>`;

  const cuff =
    style.sleeveLength === "long" ? '<path d="M 45.6 140 Q 51.5 143 57.5 143" ' + SEAM + "/>" : style.sleeveLength === "short" ? '<path d="M 51.6 47 Q 56 53 60 58" ' + STITCH + "/>" : "";
  const sleeveLayer = sleeveD
    ? [`<path d="${sleeveD}" fill="${FABRIC}"/><path d="${sleeveD}" fill="url(#sleeveShade)"/>${cuff}<path d="${sleeveD}" ${EDGE}/>`]
        .map((one) => `<g>${one}</g><g ${MIRROR}>${one}</g>`)
        .join("")
    : "";

  return `${svgOpen(width)}<rect width="${VIEW_W}" height="${VIEW_H}" fill="${BACKGROUND}"/>${defs}${shadow}${skirtLayer}${bodiceLayer}${sleeveLayer}</svg>`;
}

// ─── masks ───────────────────────────────────────────────────────────────────

function maskSvg(side: Side, style: GarmentStyle, region: SeedRegion, width: number): string {
  const bodice = bodicePath(side, style);
  const white = 'fill="#ffffff"';
  const black = 'fill="#000000"';
  const band = (top: number, bottom: number) => `<clipPath id="band"><rect x="0" y="${top}" width="${VIEW_W}" height="${bottom - top}"/></clipPath>`;
  let body: string;
  switch (region) {
    case "straps":
      body = `${band(0, STRAP_LINE)}<path d="${bodice}" ${white} clip-path="url(#band)"/>${sleeves(style, white)}`;
      break;
    case "bodice":
      body = `${band(STRAP_LINE, VIEW_H)}<path d="${bodice}" ${white} clip-path="url(#band)"/>${sleeves(style, black)}`;
      break;
    case "skirt":
      body = `<path d="${skirtPath(style)}" ${white}/>${sleeves(style, black)}`;
      break;
  }
  return `${svgOpen(width)}<rect width="${VIEW_W}" height="${VIEW_H}" ${black}/>${body}</svg>`;
}

// ─── public API ──────────────────────────────────────────────────────────────

export async function renderGarment(side: Side, style: GarmentStyle, width = GARMENT_WIDTH): Promise<Buffer> {
  return sharp(Buffer.from(garmentSvg(side, style, width))).webp({ quality: 90 }).toBuffer();
}

export async function renderMask(side: Side, style: GarmentStyle, region: SeedRegion, width = GARMENT_WIDTH): Promise<Buffer> {
  return sharp(Buffer.from(maskSvg(side, style, region, width)))
    .flatten({ background: "#000000" })
    .toColourspace("b-w")
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** Every combination of the default style options. */
export function seedStyles(): GarmentStyle[] {
  return SEED_STYLE_IDS.neckline.flatMap((neckline) =>
    SEED_STYLE_IDS.sleeveLength.flatMap((sleeveLength) => SEED_STYLE_IDS.dressLength.map((dressLength) => ({ neckline, sleeveLength, dressLength }))),
  );
}
