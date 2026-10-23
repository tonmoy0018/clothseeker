import { describe, expect, it } from "vitest";

import { garmentPicture, pickStyleVariant } from "@/lib/design/garment-variant";
import { normalizeForRender } from "@/lib/design/normalize";
import { templateConfigSchema, type StyleVariant, type TemplateConfig } from "@/types/template";

import { KEYS, PRODUCT_ID, TEMPLATE, validSpec } from "../fixtures/design";

const k = (name: string) => `${PRODUCT_ID}/template/${name.padEnd(8, "0")}-2222-4222-8222-222222222222.png`;

function withVariants(variants: StyleVariant[]): TemplateConfig {
  return templateConfigSchema.parse({ ...TEMPLATE, styleVariants: variants });
}

const choice = { neckline: "square", sleeveLength: "short", dressLength: "midi" };

describe("style pictures", () => {
  it("uses the template's own images when there are no style pictures", () => {
    const picture = garmentPicture(TEMPLATE, "front", choice);
    expect(picture.garmentKey).toBe(KEYS.front);
    expect(picture.maskFor("bodice")).toBe(KEYS.bodiceFront);
    expect(picture.maskFor("missing")).toBeUndefined();
  });

  it("picks the most specific matching picture for the side", () => {
    const any = { side: "front" as const, match: {}, image: k("a1"), masks: { bodice: k("a2") } };
    const midi = { side: "front" as const, match: { dressLength: "midi" }, image: k("b1"), masks: { bodice: k("b2") } };
    const exact = { side: "front" as const, match: { ...choice }, image: k("c1"), masks: { bodice: k("c2") } };
    const back = { side: "back" as const, match: { ...choice }, image: k("d1"), masks: {} };
    const config = withVariants([any, exact, midi, back]);
    expect(pickStyleVariant(config, "front", choice)?.image).toBe(k("c1"));
    expect(pickStyleVariant(config, "front", { ...choice, neckline: "round" })?.image).toBe(k("b1"));
    expect(pickStyleVariant(config, "front", { ...choice, dressLength: "maxi", neckline: "round" })?.image).toBe(k("a1"));
    expect(pickStyleVariant(config, "back", { ...choice, neckline: "round" })).toBeNull();
  });

  it("feeds the chosen picture and its masks into the render plan", () => {
    const exact = { side: "front" as const, match: { ...choice }, image: k("e1"), masks: { bodice: k("e2"), skirt: k("e3") } };
    const spec = validSpec();
    const plan = normalizeForRender(spec, withVariants([exact]));
    expect(plan.front.garmentKey).toBe(k("e1"));
    // Regions take this picture's masks; one the picture doesn't have (straps) isn't painted.
    expect(Object.fromEntries(plan.front.fills.map((f) => [f.regionId, f.maskKey]))).toEqual({ bodice: k("e2"), skirt: k("e3") });
    // A different style falls back to the template's own picture.
    const other = normalizeForRender({ ...spec, styleOptions: { ...spec.styleOptions, neckline: "round" } }, withVariants([exact]));
    expect(other.front.garmentKey).toBe(KEYS.front);
  });
});
