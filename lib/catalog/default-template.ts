import { DECORATION_IDS } from "@/lib/catalog/decorations";
import { DEFAULT_FINISH_PRICES } from "@/lib/catalog/finishes";
import type { GarmentType } from "@/lib/catalog/garment-types";
import { DEFAULT_ADD_ONS, TEMPLATE_CONFIG_VERSION, type TemplateConfig } from "@/types/template";

// Starting points for new customization templates (admin "Enable customization" and the seed), one
// per garment type. Rects are fractions of the garment image; they fit a standard silhouette.

export const DEFAULT_TEMPLATE_CONFIG: TemplateConfig = {
  schemaVersion: TEMPLATE_CONFIG_VERSION,
  garmentType: "dress",
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
  finishes: { ...DEFAULT_FINISH_PRICES },
  styleVariants: [],
  recolor: "multiply",
};

const option = (id: string, label: string, addOnPriceMinor = 0) => ({ id, label, addOnPriceMinor });

/** Men's shirts: body, sleeves and collar; a chest-pocket print area and one across the back yoke. */
export const DEFAULT_SHIRT_TEMPLATE_CONFIG: TemplateConfig = {
  ...DEFAULT_TEMPLATE_CONFIG,
  garmentType: "shirt",
  regions: [
    { id: "body", label: "Body", recolorable: true, masks: {} },
    { id: "sleeves", label: "Sleeves", recolorable: true, masks: {} },
    { id: "collar", label: "Collar", recolorable: true, masks: {} },
  ],
  placementAreas: [
    { id: "chest", label: "Chest", side: "front", rect: { x: 0.55, y: 0.24, w: 0.14, h: 0.1 }, widthCm: 10, heightCm: 8 },
    { id: "back-yoke", label: "Back yoke", side: "back", rect: { x: 0.34, y: 0.16, w: 0.32, h: 0.12 }, widthCm: 30, heightCm: 12 },
  ],
  styleOptions: {
    collar: [option("classic", "Classic"), option("button-down", "Button-down"), option("mandarin", "Mandarin", 10_000)],
    sleeveLength: [option("short", "Short"), option("long", "Long", 15_000)],
    fit: [option("regular", "Regular"), option("slim", "Slim"), option("relaxed", "Relaxed")],
  },
  allowedColors: [
    { name: "White", hex: "#F7F7F4" },
    { name: "Sky Blue", hex: "#A9C8E8" },
    { name: "Light Grey", hex: "#C9CBCC" },
    { name: "Navy", hex: "#1F2A44" },
    { name: "Charcoal", hex: "#3A3D42" },
    { name: "Black", hex: "#1B1B1B" },
    { name: "Sage", hex: "#9CAF88" },
    { name: "Pale Pink", hex: "#EBC9CF" },
    { name: "Olive", hex: "#6B6B3A" },
    { name: "Wine", hex: "#722F37" },
  ],
  allowedPatterns: ["stripes", "gingham", "plaid"],
  allowedFonts: ["inter", "montserrat", "playfair-display"],
  styleVariants: [],
  recolor: "multiply",
};

/** Men's panjabis: body, sleeves and collar; embroidery along the front placket and across the back. */
export const DEFAULT_PANJABI_TEMPLATE_CONFIG: TemplateConfig = {
  ...DEFAULT_SHIRT_TEMPLATE_CONFIG,
  garmentType: "panjabi",
  placementAreas: [
    { id: "placket", label: "Front placket", side: "front", rect: { x: 0.42, y: 0.12, w: 0.16, h: 0.2 }, widthCm: 12, heightCm: 18 },
    { id: "back-upper", label: "Upper back", side: "back", rect: { x: 0.36, y: 0.14, w: 0.28, h: 0.16 }, widthCm: 28, heightCm: 18 },
  ],
  styleOptions: {
    collar: [option("mandarin", "Band (mandarin)"), option("round", "Round"), option("v-placket", "V-placket", 10_000)],
    sleeveLength: [option("long", "Long"), option("three-quarter", "Three-quarter")],
    length: [option("knee", "Knee"), option("hip", "Hip"), option("long", "Long", 30_000)],
  },
  allowedColors: [
    { name: "White", hex: "#F7F7F4" },
    { name: "Ivory", hex: "#F2EBDD" },
    { name: "Beige", hex: "#D8C8A8" },
    { name: "Mustard", hex: "#D9A93F" },
    { name: "Maroon", hex: "#6E2132" },
    { name: "Bottle Green", hex: "#1E4D3B" },
    { name: "Navy", hex: "#1F2A44" },
    { name: "Sky Blue", hex: "#A9C8E8" },
    { name: "Black", hex: "#1B1B1B" },
  ],
  allowedPatterns: ["stripes"],
};

/** The starting template for a garment type. */
export function defaultTemplateConfig(type: GarmentType): TemplateConfig {
  switch (type) {
    case "shirt":
      return DEFAULT_SHIRT_TEMPLATE_CONFIG;
    case "panjabi":
      return DEFAULT_PANJABI_TEMPLATE_CONFIG;
    default:
      return DEFAULT_TEMPLATE_CONFIG;
  }
}
