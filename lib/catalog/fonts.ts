// Curated fonts for customer text layers. All are open-licence Google Fonts so print files can embed them.

export const FONTS = [
  { id: "inter", label: "Inter", family: "Inter", style: "Clean sans-serif" },
  { id: "montserrat", label: "Montserrat", family: "Montserrat", style: "Geometric sans-serif" },
  { id: "playfair-display", label: "Playfair Display", family: "Playfair Display", style: "Elegant serif" },
  { id: "roboto-slab", label: "Roboto Slab", family: "Roboto Slab", style: "Slab serif" },
  { id: "dancing-script", label: "Dancing Script", family: "Dancing Script", style: "Handwritten script" },
  { id: "lobster", label: "Lobster", family: "Lobster", style: "Bold display script" },
] as const;

export type FontId = (typeof FONTS)[number]["id"];
export const FONT_IDS = FONTS.map((f) => f.id) as [FontId, ...FontId[]];
