import { STYLE_GROUPS, type StyleGroup, type StyleVariant, type TemplateConfig } from "@/types/template";

// Which garment picture (and region masks) shows a design's style choices.
// Pure and shared by the browser preview and the server renderer, so both always pick the same one.

export type Side = "front" | "back";
export type StyleChoice = { neckline: string; sleeveLength: string; dressLength: string };

export type GarmentPicture = {
  /** Storage key of the garment image, or null when the template has none for this side. */
  garmentKey: string | null;
  /** Mask key for a region on this picture, if the region appears on it. */
  maskFor: (regionId: string) => string | undefined;
  /** False when no picture shows exactly these choices and the closest one is used instead. */
  exact: boolean;
};

/** How much a group counts when looking for the closest picture: length shows most, then sleeves. */
const WEIGHT: Record<StyleGroup, number> = { dressLength: 4, sleeveLength: 2, neckline: 1 };

function matches(variant: StyleVariant, choice: StyleChoice): boolean {
  return STYLE_GROUPS.every((group) => variant.match[group] === undefined || variant.match[group] === choice[group]);
}

function specificity(variant: StyleVariant): number {
  return STYLE_GROUPS.filter((group) => variant.match[group] !== undefined).length;
}

function closeness(variant: StyleVariant, choice: StyleChoice): number {
  return STYLE_GROUPS.reduce((sum, group) => sum + (variant.match[group] === undefined || variant.match[group] === choice[group] ? WEIGHT[group] : 0), 0);
}

/** The most specific matching style picture for this side (first one wins a tie), or null. */
export function pickStyleVariant(config: TemplateConfig, side: Side, choice: StyleChoice): StyleVariant | null {
  let best: StyleVariant | null = null;
  for (const variant of config.styleVariants) {
    if (variant.side === side && matches(variant, choice) && (best === null || specificity(variant) > specificity(best))) {
      best = variant;
    }
  }
  return best;
}

/** The style picture closest to these choices for this side (first one wins a tie), or null if there are none. */
function closestStyleVariant(config: TemplateConfig, side: Side, choice: StyleChoice): StyleVariant | null {
  let best: StyleVariant | null = null;
  for (const variant of config.styleVariants) {
    if (variant.side === side && (best === null || closeness(variant, choice) > closeness(best, choice))) {
      best = variant;
    }
  }
  return best;
}

/**
 * The garment picture for these style choices: an exact style picture, else the closest style picture
 * (while a set is incomplete), else the template's own images.
 */
export function garmentPicture(config: TemplateConfig, side: Side, choice: StyleChoice): GarmentPicture {
  const exact = pickStyleVariant(config, side, choice);
  const variant = exact ?? closestStyleVariant(config, side, choice);
  if (variant) {
    return { garmentKey: variant.image, maskFor: (regionId) => variant.masks[regionId], exact: exact !== null };
  }
  return {
    garmentKey: config.garmentImages[side] ?? null,
    maskFor: (regionId) => config.regions.find((r) => r.id === regionId)?.masks[side],
    exact: config.styleVariants.length === 0,
  };
}
