import type { Size } from "@/lib/generated/prisma/enums";
import { TEMPLATE_CONFIG_VERSION, type TemplateConfig } from "@/types/template";

// Demo catalog for ClothSeeker. Prices are whole taka (converted to poisha by the seed).

export const SEED_CATEGORIES = [
  { slug: "casual", name: "Casual", sortOrder: 1 },
  { slug: "party", name: "Party", sortOrder: 2 },
  { slug: "formal", name: "Formal", sortOrder: 3 },
  { slug: "summer", name: "Summer", sortOrder: 4 },
  { slug: "traditional", name: "Traditional", sortOrder: 5 },
] as const;

export type SeedCategorySlug = (typeof SEED_CATEGORIES)[number]["slug"];

export type SeedProduct = {
  slug: string;
  name: string;
  category: SeedCategorySlug;
  description: string;
  colors: readonly { name: string; hex: string }[];
  sizes: readonly Size[];
  priceTaka: number;
  customizable: boolean;
  status?: "ACTIVE" | "DRAFT";
};

const C = {
  sage: { name: "Sage", hex: "#9CAF88" },
  sand: { name: "Sand", hex: "#D8C3A5" },
  inkNavy: { name: "Ink Navy", hex: "#2E3A59" },
  skyBlue: { name: "Sky Blue", hex: "#8FB8DE" },
  white: { name: "White", hex: "#F5F5F0" },
  terracotta: { name: "Terracotta", hex: "#C8664B" },
  mustard: { name: "Mustard", hex: "#D9A93F" },
  champagne: { name: "Champagne", hex: "#E8D3B0" },
  emerald: { name: "Emerald", hex: "#1F6F50" },
  black: { name: "Black", hex: "#1B1B1B" },
  silver: { name: "Silver", hex: "#C0C0C8" },
  midnight: { name: "Midnight", hex: "#191970" },
  rosePink: { name: "Rose Pink", hex: "#E8A0B4" },
  lilac: { name: "Lilac", hex: "#B9A6D9" },
  wine: { name: "Wine", hex: "#722F37" },
  navy: { name: "Navy", hex: "#1F2A44" },
  charcoal: { name: "Charcoal", hex: "#36454F" },
  ivory: { name: "Ivory", hex: "#F4EFE3" },
  ruby: { name: "Ruby", hex: "#9B111E" },
  teal: { name: "Teal", hex: "#0F5257" },
  coral: { name: "Coral", hex: "#F28C6F" },
  butter: { name: "Butter Yellow", hex: "#F3DE8A" },
  turquoise: { name: "Turquoise", hex: "#30B6C2" },
  mint: { name: "Mint", hex: "#A8D5BA" },
  peach: { name: "Peach", hex: "#F6C1A3" },
  indigo: { name: "Indigo", hex: "#3F4C8C" },
  maroon: { name: "Maroon", hex: "#800020" },
  gold: { name: "Gold", hex: "#C9A227" },
  rust: { name: "Rust", hex: "#B7410E" },
  olive: { name: "Olive", hex: "#708238" },
} as const;

const XS_XL: readonly Size[] = ["XS", "S", "M", "L", "XL"];
const S_XXL: readonly Size[] = ["S", "M", "L", "XL", "XXL"];
const XS_L: readonly Size[] = ["XS", "S", "M", "L"];
const S_XL: readonly Size[] = ["S", "M", "L", "XL"];

export const SEED_PRODUCTS: readonly SeedProduct[] = [
  {
    slug: "linen-wrap-dress",
    name: "Linen Wrap Dress",
    category: "casual",
    description: "A breathable linen wrap dress with a tie waist and soft A-line skirt. Easy to wear from morning to evening.",
    colors: [C.sage, C.sand, C.inkNavy],
    sizes: XS_XL,
    priceTaka: 3200,
    customizable: true,
  },
  {
    slug: "everyday-shirt-dress",
    name: "Everyday Shirt Dress",
    category: "casual",
    description: "Crisp cotton poplin shirt dress with a button front, roll-up sleeves and a removable belt.",
    colors: [C.skyBlue, C.white],
    sizes: S_XXL,
    priceTaka: 2450,
    customizable: false,
  },
  {
    slug: "cotton-tiered-midi",
    name: "Cotton Tiered Midi",
    category: "casual",
    description: "Three soft tiers of lightweight cotton with a smocked back for a relaxed, swingy fit.",
    colors: [C.terracotta, C.mustard],
    sizes: XS_L,
    priceTaka: 2850,
    customizable: true,
  },
  {
    slug: "satin-slip-dress",
    name: "Satin Slip Dress",
    category: "party",
    description: "Bias-cut satin slip dress with adjustable straps and a cowl neckline that drapes beautifully.",
    colors: [C.champagne, C.emerald, C.black],
    sizes: XS_L,
    priceTaka: 5900,
    customizable: false,
  },
  {
    slug: "sequin-cocktail-dress",
    name: "Sequin Cocktail Dress",
    category: "party",
    description: "All-over sequin cocktail dress, fully lined, with a flattering straight neckline.",
    colors: [C.silver, C.midnight],
    sizes: S_XL,
    priceTaka: 8750,
    customizable: false,
  },
  {
    slug: "ruffle-mini-dress",
    name: "Ruffle Mini Dress",
    category: "party",
    description: "Playful georgette mini dress with ruffled sleeves and a fitted waist.",
    colors: [C.rosePink, C.lilac],
    sizes: ["XS", "S", "M"],
    priceTaka: 3950,
    customizable: true,
  },
  {
    slug: "pleated-maxi-gown",
    name: "Pleated Maxi Gown",
    category: "formal",
    description: "Floor-length gown with sunray pleats, a cinched waist and a subtle sweep train.",
    colors: [C.wine, C.navy],
    sizes: S_XL,
    priceTaka: 9500,
    customizable: false,
  },
  {
    slug: "tailored-sheath-dress",
    name: "Tailored Sheath Dress",
    category: "formal",
    description: "A sharp, knee-length sheath in stretch crepe with princess seams and a hidden back zip.",
    colors: [C.black, C.charcoal, C.ivory],
    sizes: XS_XL,
    priceTaka: 6200,
    customizable: true,
  },
  {
    slug: "off-shoulder-evening-dress",
    name: "Off-Shoulder Evening Dress",
    category: "formal",
    description: "Structured off-shoulder bodice with a flowing midi skirt for evening events.",
    colors: [C.ruby, C.teal],
    sizes: ["S", "M", "L"],
    priceTaka: 7800,
    customizable: false,
  },
  {
    slug: "floral-sundress",
    name: "Floral Sundress",
    category: "summer",
    description: "Light viscose sundress with thin straps, a sweetheart neckline and pockets.",
    colors: [C.coral, C.butter],
    sizes: XS_L,
    priceTaka: 1950,
    customizable: false,
  },
  {
    slug: "halter-beach-dress",
    name: "Halter Beach Dress",
    category: "summer",
    description: "Halter-neck maxi in airy cotton voile, made for warm days by the sea.",
    colors: [C.turquoise, C.white],
    sizes: S_XL,
    priceTaka: 1800,
    customizable: false,
  },
  {
    slug: "smocked-cotton-dress",
    name: "Smocked Cotton Dress",
    category: "summer",
    description: "Smocked bodice, puff sleeves and a midi skirt in soft breathable cotton.",
    colors: [C.mint, C.peach],
    sizes: XS_XL,
    priceTaka: 2250,
    customizable: true,
  },
  {
    slug: "embroidered-kurti-dress",
    name: "Embroidered Kurti Dress",
    category: "traditional",
    description: "Knee-length kurti dress with hand-finished thread embroidery around the neckline and cuffs.",
    colors: [C.indigo, C.maroon],
    sizes: S_XXL,
    priceTaka: 3450,
    customizable: false,
  },
  {
    slug: "jamdani-inspired-anarkali",
    name: "Jamdani-Inspired Anarkali",
    category: "traditional",
    description: "Flared Anarkali silhouette with a woven-motif border inspired by Jamdani weaving.",
    colors: [C.ivory, C.gold],
    sizes: S_XL,
    priceTaka: 7250,
    customizable: false,
  },
  {
    slug: "block-print-maxi-dress",
    name: "Block-Print Maxi Dress",
    category: "traditional",
    description: "Hand block-printed cotton maxi with a tie neck and three-quarter sleeves.",
    colors: [C.rust, C.olive],
    sizes: XS_XL,
    priceTaka: 2950,
    customizable: false,
  },
  {
    slug: "velvet-holiday-dress",
    name: "Velvet Holiday Dress",
    category: "formal",
    description: "Draft listing — not visible in the shop until published.",
    colors: [C.wine],
    sizes: ["S", "M", "L"],
    priceTaka: 6900,
    customizable: false,
    status: "DRAFT",
  },
];

/** Larger sizes cost a little more, like real pattern grading. */
export function sizeSurchargeTaka(size: Size): number {
  return size === "XL" ? 200 : size === "XXL" ? 300 : 0;
}

/** Deterministic stock so re-seeding is reproducible; about one variant in nine is sold out. */
export function seedStock(productIndex: number, sizeIndex: number, colorIndex: number): number {
  return (productIndex * 7 + sizeIndex * 3 + colorIndex * 5) % 9;
}

export const DEFAULT_TEMPLATE_CONFIG: TemplateConfig = {
  schemaVersion: TEMPLATE_CONFIG_VERSION,
  regions: [
    { id: "bodice", label: "Bodice", recolorable: true },
    { id: "sleeves", label: "Sleeves", recolorable: true },
    { id: "skirt", label: "Skirt", recolorable: true },
    { id: "collar", label: "Collar", recolorable: true },
  ],
  placementAreas: [
    { id: "front-chest", label: "Front chest", side: "front", widthCm: 20, heightCm: 15 },
    { id: "front-skirt", label: "Front skirt", side: "front", widthCm: 35, heightCm: 30 },
    { id: "back-upper", label: "Upper back", side: "back", widthCm: 30, heightCm: 25 },
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
    C.black, C.white, C.ivory, C.navy, C.sage, C.terracotta, C.mustard,
    C.rosePink, C.lilac, C.emerald, C.wine, C.skyBlue,
  ],
};
