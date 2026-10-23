import { DECORATION_IDS } from "@/lib/catalog/decorations";
import { DEFAULT_ADD_ONS, TEMPLATE_CONFIG_VERSION, type TemplateConfig } from "@/types/template";

// Starting point for a new customization template (admin "Enable customization" and the seed).
// Rects are fractions of the garment image; they fit the standard dress silhouette.

export const DEFAULT_TEMPLATE_CONFIG: TemplateConfig = {
  schemaVersion: TEMPLATE_CONFIG_VERSION,
  garmentImages: {},
  regions: [
    { id: "bodice", label: "Bodice", recolorable: true, masks: {} },
    { id: "sleeves", label: "Sleeves", recolorable: true, masks: {} },
    { id: "skirt", label: "Skirt", recolorable: true, masks: {} },
    { id: "collar", label: "Collar", recolorable: true, masks: {} },
  ],
  placementAreas: [
    {
      id: "front-chest",
      label: "Front chest",
      side: "front",
      rect: { x: 0.4, y: 0.2, w: 0.2, h: 0.14 },
      widthCm: 20,
      heightCm: 15,
    },
    {
      id: "front-skirt",
      label: "Front skirt",
      side: "front",
      rect: { x: 0.32, y: 0.5, w: 0.36, h: 0.3 },
      widthCm: 35,
      heightCm: 30,
    },
    {
      id: "back-upper",
      label: "Upper back",
      side: "back",
      rect: { x: 0.38, y: 0.18, w: 0.24, h: 0.18 },
      widthCm: 30,
      heightCm: 25,
    },
  ],
  styleOptions: {
    neckline: [
      { id: "round", label: "Round", addOnPriceMinor: 0 },
      { id: "v-neck", label: "V-neck", addOnPriceMinor: 0 },
      { id: "square", label: "Square", addOnPriceMinor: 15_000 },
    ],
    sleeveLength: [
      { id: "sleeveless", label: "Sleeveless", addOnPriceMinor: 0 },
      { id: "short", label: "Short", addOnPriceMinor: 0 },
      { id: "long", label: "Long", addOnPriceMinor: 25_000 },
    ],
    dressLength: [
      { id: "mini", label: "Mini", addOnPriceMinor: 0 },
      { id: "midi", label: "Midi", addOnPriceMinor: 20_000 },
      { id: "maxi", label: "Maxi", addOnPriceMinor: 40_000 },
    ],
  },
  allowedColors: [
    { name: "Black", hex: "#1B1B1B" },
    { name: "White", hex: "#F5F5F0" },
    { name: "Ivory", hex: "#F4EFE3" },
    { name: "Navy", hex: "#1F2A44" },
    { name: "Sage", hex: "#9CAF88" },
    { name: "Terracotta", hex: "#C8664B" },
    { name: "Mustard", hex: "#D9A93F" },
    { name: "Rose Pink", hex: "#E8A0B4" },
    { name: "Lilac", hex: "#B9A6D9" },
    { name: "Emerald", hex: "#1F6F50" },
    { name: "Wine", hex: "#722F37" },
    { name: "Sky Blue", hex: "#8FB8DE" },
  ],
  allowedPatterns: ["stripes", "polka-dots", "gingham", "floral"],
  allowedFonts: ["inter", "playfair-display", "dancing-script", "montserrat"],
  allowedDecorations: [...DECORATION_IDS],
  addOns: DEFAULT_ADD_ONS,
  styleVariants: [],
};
