// How an item (text, decoration, cut-out) is made on the garment: printed (the default), embroidered
// or sequinned. Each finish has its own price per item (per motif in a border), set per template.
// The texture SVG here is drawn over a finished item by both the renderer and the design screen, so
// previews match. Pure: no Node or browser imports.

export const FINISH_IDS = ["embroidery", "sequins"] as const;
export type FinishId = (typeof FINISH_IDS)[number];
/** "print" is the absence of a finish. */
export type Finish = "print" | FinishId;

export const FINISH_LABEL: Record<Finish, string> = { print: "Print", embroidery: "Embroidery", sequins: "Sequins" };

export type FinishedKind = "text" | "decoration" | "cutout" | "image";

/** Finishes each kind of item can have: photos and logos can only be printed; text can't be sequinned. */
export function finishesFor(kind: FinishedKind): readonly Finish[] {
  switch (kind) {
    case "text":
      return ["print", "embroidery"];
    case "decoration":
    case "cutout":
      return ["print", "embroidery", "sequins"];
    case "image":
      return ["print"];
  }
}

/** Default prices (poisha) when a template first gets finishes. */
export const DEFAULT_FINISH_PRICES: Record<FinishId, number> = { embroidery: 25_000, sequins: 35_000 };

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * A texture of exactly width×height to lay over a finished item (only where the item is drawn):
 * satin stitches for embroidery, overlapping shiny discs for sequins. `pxPerCm` keeps stitches and
 * sequins their real size (about 0.8 mm stitches, 4 mm sequins).
 */
export function finishTextureSvg(finish: FinishId, width: number, height: number, pxPerCm: number): string {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
  if (finish === "embroidery") {
    // Satin stitches: fine, rounded threads, each lit along one side and shaded along the other.
    const p = r2(Math.max(2.5, pxPerCm * 0.08));
    return (
      `${open}<defs><linearGradient id="t" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="#000000" stop-opacity="0.22"/><stop offset="0.3" stop-color="#ffffff" stop-opacity="0.32"/>` +
      `<stop offset="0.55" stop-color="#ffffff" stop-opacity="0.05"/><stop offset="1" stop-color="#000000" stop-opacity="0.26"/>` +
      `</linearGradient><pattern id="s" width="${r2(p * 6)}" height="${p}" patternUnits="userSpaceOnUse" patternTransform="rotate(40)">` +
      `<rect width="${r2(p * 6)}" height="${p}" fill="url(#t)"/></pattern></defs><rect width="${w}" height="${h}" fill="url(#s)"/></svg>`
    );
  }
  const d = Math.max(6, pxPerCm * 0.4);
  const rows = Math.ceil(h / (d * 0.87)) + 1;
  const cols = Math.ceil(w / d) + 1;
  const discs: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const cx = r2(col * d + (row % 2 ? d / 2 : 0));
      const cy = r2(row * d * 0.87);
      discs.push(`<circle cx="${cx}" cy="${cy}" r="${r2(d * 0.48)}" fill="url(#g)" stroke="#000000" stroke-opacity="0.25" stroke-width="${r2(Math.max(0.6, d * 0.06))}"/>`);
    }
  }
  return (
    `${open}<defs><radialGradient id="g" cx="0.35" cy="0.3" r="0.7">` +
    `<stop offset="0" stop-color="#ffffff" stop-opacity="0.9"/><stop offset="0.35" stop-color="#ffffff" stop-opacity="0.25"/>` +
    `<stop offset="0.75" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.3"/>` +
    `</radialGradient></defs>${discs.join("")}</svg>`
  );
}
