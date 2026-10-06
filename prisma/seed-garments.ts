import sharp from "sharp";

// Neutral garment silhouettes and matching region masks for the seeded dresses.
// Our own trusted SVG (never user input), rasterized at 1200×1560. Masks use the exact same
// outline, cut into horizontal bands, so every region lines up with the garment image.

const SIZE = 'viewBox="0 0 200 260" width="1200" height="1560"';
const OUTLINE = 'stroke="#9a9a9a" stroke-width="2.2" stroke-linejoin="round"';

const SILHOUETTE = {
  front: "M82 18 L88 18 L91 44 L109 44 L112 18 L118 18 L124 52 L128 100 L170 238 Q100 256 30 238 L72 100 L76 52 Z",
  back: "M82 18 L88 18 L92 30 L108 30 L112 18 L118 18 L124 52 L128 100 L170 238 Q100 256 30 238 L72 100 L76 52 Z",
} as const;

/** Where the straps end (neckline) and the skirt begins (waist), in viewBox units. */
const BANDS = { front: { neck: 44, waist: 102 }, back: { neck: 30, waist: 102 } } as const;

export type SeedRegion = "straps" | "bodice" | "skirt";
export const SEED_REGIONS: readonly { id: SeedRegion; label: string }[] = [
  { id: "straps", label: "Straps" },
  { id: "bodice", label: "Bodice" },
  { id: "skirt", label: "Skirt" },
];

function garmentSvg(side: "front" | "back"): string {
  const seam = side === "back" ? '<path d="M100 30 L100 100" fill="none" stroke="#b5b5b5" stroke-width="1.5" stroke-dasharray="3 3"/>' : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ${SIZE}><rect width="200" height="260" fill="#ffffff"/>` +
    `<path d="${SILHOUETTE[side]}" fill="${side === "front" ? "#ececec" : "#e4e4e4"}" ${OUTLINE}/>` +
    `<path d="M72 100 Q100 108 128 100" fill="none" ${OUTLINE}/>${seam}</svg>`
  );
}

function maskSvg(side: "front" | "back", region: SeedRegion): string {
  const { neck, waist } = BANDS[side];
  const band = region === "straps" ? [0, neck] : region === "bodice" ? [neck, waist] : [waist, 260];
  const [top = 0, bottom = 260] = band;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ${SIZE}><rect width="200" height="260" fill="#000000"/>` +
    `<clipPath id="band"><rect x="0" y="${top}" width="200" height="${bottom - top}"/></clipPath>` +
    `<path d="${SILHOUETTE[side]}" fill="#ffffff" clip-path="url(#band)"/></svg>`
  );
}

export async function renderGarment(side: "front" | "back"): Promise<Buffer> {
  return sharp(Buffer.from(garmentSvg(side))).webp({ quality: 90 }).toBuffer();
}

export async function renderMask(side: "front" | "back", region: SeedRegion): Promise<Buffer> {
  return sharp(Buffer.from(maskSvg(side, region)))
    .flatten({ background: "#000000" })
    .toColourspace("b-w")
    .png({ compressionLevel: 9 })
    .toBuffer();
}
