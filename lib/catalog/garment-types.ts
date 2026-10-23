// The kinds of garment ClothSeeker makes to order, and the style choices each one offers.
// Pure data, safe for client and server. A customization template names its garment type; its style
// options must cover exactly that type's groups (types/template.ts checks this).

export const STYLE_GROUP_IDS = ["neckline", "collar", "sleeveLength", "dressLength", "length", "fit"] as const;
export type StyleGroup = (typeof STYLE_GROUP_IDS)[number];

export const STYLE_GROUP_LABEL: Record<StyleGroup, string> = {
  neckline: "Neckline",
  collar: "Collar",
  sleeveLength: "Sleeves",
  dressLength: "Length",
  length: "Length",
  fit: "Fit",
};

/**
 * How much a group changes a garment's look. When no picture shows a customer's exact choices, the
 * closest one is shown (lib/design/garment-variant.ts): length shows most, then sleeves and fit.
 */
export const STYLE_GROUP_WEIGHT: Record<StyleGroup, number> = { dressLength: 4, length: 4, sleeveLength: 2, fit: 2, neckline: 1, collar: 1 };

export const GARMENT_TYPE_IDS = ["dress", "shirt", "panjabi"] as const;
export type GarmentType = (typeof GARMENT_TYPE_IDS)[number];

export type GarmentTypeInfo = {
  label: string;
  /** Lower-case name used in sentences ("Customize this shirt"). */
  noun: string;
  /** Who it's for, for shop navigation. */
  audience: "women" | "men";
  groups: readonly StyleGroup[];
  /** The garment category try-on models expect (OOTDiffusion's names). */
  tryOnCategory: "Dress" | "Upper-body";
};

export const GARMENT_TYPES: Record<GarmentType, GarmentTypeInfo> = {
  dress: { label: "Dress", noun: "dress", audience: "women", groups: ["neckline", "sleeveLength", "dressLength"], tryOnCategory: "Dress" },
  shirt: { label: "Shirt", noun: "shirt", audience: "men", groups: ["collar", "sleeveLength", "fit"], tryOnCategory: "Upper-body" },
  // A panjabi is worn over trousers, so try-on treats it as a (long) top.
  panjabi: { label: "Panjabi", noun: "panjabi", audience: "men", groups: ["collar", "sleeveLength", "length"], tryOnCategory: "Upper-body" },
};

export function styleGroupsOf(type: GarmentType): readonly StyleGroup[] {
  return GARMENT_TYPES[type].groups;
}

export const AUDIENCE_IDS = ["women", "men"] as const;
export type Audience = (typeof AUDIENCE_IDS)[number];

/** Shop sections: a menu label, a heading, and what to call their products. */
export const AUDIENCES: Record<Audience, { label: string; heading: string; plural: string }> = {
  women: { label: "Women", heading: "Women's dresses", plural: "dresses" },
  men: { label: "Men", heading: "Men's shirts & panjabis", plural: "items" },
};

export function garmentTypesFor(audience: Audience): GarmentType[] {
  return GARMENT_TYPE_IDS.filter((type) => GARMENT_TYPES[type].audience === audience);
}
