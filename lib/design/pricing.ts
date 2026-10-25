import type { DesignSpec } from "@/types/design-spec";
import { GARMENT_TYPES, STYLE_GROUP_LABEL } from "@/lib/catalog/garment-types";
import { styleOptionsFor, templateStyleGroups, type TemplateConfig } from "@/types/template";

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
  for (const line of [
    countLine("Pattern", patterned, template.addOns.patternMinor),
    // An all-over print is printed fabric: priced like a pattern.
    countLine("All-over print", printed, template.addOns.patternMinor),
    countLine("Text", count("text"), template.addOns.textMinor),
    countLine("Image", count("image"), template.addOns.imageMinor),
    countLine("Decoration", count("decoration"), template.addOns.decorationMinor),
  ]) {
    if (line) {
      lines.push(line);
    }
  }

  return { lines, totalMinor: lines.reduce((sum, l) => sum + l.amountMinor, 0) };
}
