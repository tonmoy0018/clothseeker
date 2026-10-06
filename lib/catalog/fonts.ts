// Curated fonts for customer text layers. All are open-licence Google Fonts so print files can embed them.
// Files live in public/fonts/<id>.ttf; the browser (@font-face) and the server renderer use the same files.

export const FONT_IDS = ["inter", "montserrat", "playfair-display", "roboto-slab", "dancing-script", "lobster"] as const;
export type FontId = (typeof FONT_IDS)[number];

const FONT_INFO: Record<FontId, { label: string; style: string }> = {
  inter: { label: "Inter", style: "Clean sans-serif" },
  montserrat: { label: "Montserrat", style: "Geometric sans-serif" },
  "playfair-display": { label: "Playfair Display", style: "Elegant serif" },
  "roboto-slab": { label: "Roboto Slab", style: "Slab serif" },
  "dancing-script": { label: "Dancing Script", style: "Handwritten script" },
  lobster: { label: "Lobster", style: "Bold display script" },
};

/** `family` is the CSS font-family registered via @font-face on the design screen. */
export const FONTS = FONT_IDS.map((id) => ({ id, ...FONT_INFO[id], family: `cs-${id}` }));

/** Public URL of a font file (also its path under /public). */
export function fontUrl(id: FontId): string {
  return `/fonts/${id}.ttf`;
}
