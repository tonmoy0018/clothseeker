import { describe, expect, it } from "vitest";

import { GARMENT_TYPE_IDS, GARMENT_TYPES, STYLE_GROUP_LABEL, styleGroupsOf } from "@/lib/catalog/garment-types";
import { priceDesign } from "@/lib/design/pricing";
import { validateDesignAgainstTemplate } from "@/lib/design/validate";
import { templateConfigSchema } from "@/types/template";

import { CONTEXT, TEMPLATE, validSpec } from "../fixtures/design";

// Garment types decide which style choices a template offers; validation, prices and labels follow them.

const option = (id: string, addOnPriceMinor = 0) => ({ id, label: id[0]?.toUpperCase() + id.slice(1), addOnPriceMinor });

const SHIRT = templateConfigSchema.parse({
  ...TEMPLATE,
  garmentType: "shirt",
  styleOptions: {
    collar: [option("classic"), option("mandarin", 20_000)],
    sleeveLength: [option("short"), option("long", 15_000)],
    fit: [option("slim"), option("regular")],
  },
});

describe("garment types", () => {
  it("each type has its own style groups, all labelled", () => {
    for (const type of GARMENT_TYPE_IDS) {
      const groups = styleGroupsOf(type);
      expect(groups.length, type).toBeGreaterThan(0);
      expect(new Set(groups).size, type).toBe(groups.length);
      for (const group of groups) expect(STYLE_GROUP_LABEL[group]).toBeTruthy();
    }
    expect(styleGroupsOf("dress")).toEqual(["neckline", "sleeveLength", "dressLength"]);
    expect(styleGroupsOf("shirt")).toEqual(["collar", "sleeveLength", "fit"]);
    expect(GARMENT_TYPES.shirt.tryOnCategory).toBe("Upper-body");
  });

  it("a shirt design validates and prices with collar, sleeves and fit", () => {
    const spec = validSpec({ styleOptions: { collar: "mandarin", sleeveLength: "long", fit: "slim" } });
    expect(validateDesignAgainstTemplate(spec, SHIRT, CONTEXT)).toEqual([]);
    const price = priceDesign(spec, SHIRT, 300_000);
    expect(price.lines.map((l) => l.label)).toEqual(expect.arrayContaining(["Shirt, size M", "Collar: Mandarin", "Sleeves: Long"]));
  });

  it("refuses dress choices on a shirt, and missing shirt choices, in the shirt's own words", () => {
    const issues = validateDesignAgainstTemplate(validSpec(), SHIRT, CONTEXT);
    expect(issues.map((i) => i.path)).toEqual(expect.arrayContaining(["styleOptions.collar", "styleOptions.fit", "styleOptions.neckline", "styleOptions.dressLength"]));
    expect(issues.find((i) => i.path === "styleOptions.neckline")?.message).toBe("A shirt has no neckline option.");
  });
});
