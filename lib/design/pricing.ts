import type { DesignSpec } from "@/types/design-spec";
import { STYLE_GROUPS, type StyleGroup, type TemplateConfig } from "@/types/template";

// Price of a custom design from the template's rules. Pure: the browser uses it for the live
// price, and the server recomputes it from trusted data at every save, add-to-cart and checkout.
// Call only with a spec that passed validateDesignAgainstTemplate().

export type PriceLine = { label: string; amountMinor: number };
export type DesignPrice = { lines: PriceLine[]; totalMinor: number };

const GROUP_LABEL: Record<StyleGroup, string> = {
  neckline: "Neckline",
  sleeveLength: "Sleeves",
  dressLength: "Length",
};

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
  const lines: PriceLine[] = [{ label: `Dress, size ${spec.size}`, amountMinor: basePriceMinor }];

  for (const group of STYLE_GROUPS) {
    const option = template.styleOptions[group].find((o) => o.id === spec.styleOptions[group]);
    if (!option) {
      throw new Error(`Unknown ${group} option`);
    }
    if (option.addOnPriceMinor > 0) {
      lines.push({ label: `${GROUP_LABEL[group]}: ${option.label}`, amountMinor: option.addOnPriceMinor });
    }
  }

  const patterned = Object.values(spec.parts).filter((p) => p.pattern).length;
  const count = (kind: DesignSpec["layers"][number]["kind"]) => spec.layers.filter((l) => l.kind === kind).length;
  for (const line of [
    countLine("Pattern", patterned, template.addOns.patternMinor),
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
