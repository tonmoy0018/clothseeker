import type { DesignSpec } from "@/types/design-spec";
import { GARMENT_TYPES, STYLE_GROUP_LABEL } from "@/lib/catalog/garment-types";
import { styleOptionsFor, templateStyleGroups, type TemplateConfig } from "@/types/template";

import { isCutoutKey, layerMotifs } from "./validate";

// Price of a custom design from the template's rules. Pure: the browser uses it for the live
// price, and the server recomputes it from trusted data at every save, add-to-cart and checkout.
// Call only with a spec that passed validateDesignAgainstTemplate().

export type PriceLine = { label: string; amountMinor: number };
export type DesignPrice = { lines: PriceLine[]; totalMinor: number };

/** Base price for a size: the cheapest active ready-made variant in that size. */
export function basePriceForSize(
  variants: readonly { size: string; priceMinor: number; isActive: boolean }[],
  size: string,
): number | null {
  const prices = variants.filter((v) => v.isActive && v.size === size).map((v) => v.priceMinor);
  return prices.length > 0 ? Math.min(...prices) : null;
}

function countLine(label: string, count: number, unitMinor: number): PriceLine | null {
  if (count === 0 || unitMinor === 0) {
    return null;
  }
  return { label: count === 1 ? label : `${label} × ${count}`, amountMinor: count * unitMinor };
}

export function priceDesign(spec: DesignSpec, template: TemplateConfig, basePriceMinor: number): DesignPrice {
  const lines: PriceLine[] = [{ label: `${GARMENT_TYPES[template.garmentType].label}, size ${spec.size}`, amountMinor: basePriceMinor }];

  for (const group of templateStyleGroups(template)) {
    const option = styleOptionsFor(template, group).find((o) => o.id === spec.styleOptions[group]);
    if (!option) {
      throw new Error(`Unknown ${group} option`);
    }
    if (option.addOnPriceMinor > 0) {
      lines.push({ label: `${STYLE_GROUP_LABEL[group]}: ${option.label}`, amountMinor: option.addOnPriceMinor });
    }
  }

  const patterned = Object.values(spec.parts).filter((p) => p.pattern).length;
  const printed = Object.values(spec.parts).filter((p) => p.print).length;
  const count = (kind: DesignSpec["layers"][number]["kind"]) => spec.layers.filter((l) => l.kind === kind).length;
  // A decoration cut out of one of our dresses is made like a decoration; other images are printed.
  const isCutout = (l: DesignSpec["layers"][number]) => l.kind === "image" && isCutoutKey(l.image.assetKey);
  const motifs = spec.layers.reduce((sum, l) => sum + (l.kind === "decoration" || isCutout(l) ? layerMotifs(l) : 0), 0);
  const images = spec.layers.reduce((sum, l) => sum + (l.kind === "image" && !isCutout(l) ? layerMotifs(l) : 0), 0);
  for (const line of [
    countLine("Pattern", patterned, template.addOns.patternMinor),
    // An all-over print is printed fabric: priced like a pattern.
    countLine("All-over print", printed, template.addOns.patternMinor),
    countLine("Text", count("text"), template.addOns.textMinor),
    countLine("Image", images, template.addOns.imageMinor),
    // A border is priced per motif (each repeat is made like one decoration).
    countLine("Decoration", motifs, template.addOns.decorationMinor),
  ]) {
    if (line) {
      lines.push(line);
    }
  }

  return { lines, totalMinor: lines.reduce((sum, l) => sum + l.amountMinor, 0) };
}
