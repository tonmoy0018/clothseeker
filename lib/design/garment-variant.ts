import { STYLE_GROUPS, type StyleVariant, type TemplateConfig } from "@/types/template";

// Which garment picture (and region masks) shows a design's style choices.
// Pure and shared by the browser preview and the server renderer, so both always pick the same one.

export type Side = "front" | "back";
export type StyleChoice = { neckline: string; sleeveLength: string; dressLength: string };

export type GarmentPicture = {
  /** Storage key of the garment image, or null when the template has none for this side. */
  garmentKey: string | null;
  /** Mask key for a region on this picture, if the region appears on it. */
  maskFor: (regionId: string) => string | undefined;
};

function matches(variant: StyleVariant, choice: StyleChoice): boolean {
  return STYLE_GROUPS.every((group) => variant.match[group] === undefined || variant.match[group] === choice[group]);
}

function specificity(variant: StyleVariant): number {
  return STYLE_GROUPS.filter((group) => variant.match[group] !== undefined).length;
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

/** The garment picture for these style choices, falling back to the template's own images. */
export function garmentPicture(config: TemplateConfig, side: Side, choice: StyleChoice): GarmentPicture {
  const variant = pickStyleVariant(config, side, choice);
  if (variant) {
    return { garmentKey: variant.image, maskFor: (regionId) => variant.masks[regionId] };
  }
  return {
    garmentKey: config.garmentImages[side] ?? null,
    maskFor: (regionId) => config.regions.find((r) => r.id === regionId)?.masks[side],
  };
}
