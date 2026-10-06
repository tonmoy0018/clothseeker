import { describe, expect, it } from "vitest";

import { changedFields } from "@/lib/admin/audit";
import { slugSchema } from "@/lib/admin/products";
import { generateSku } from "@/lib/admin/variants";
import { slugify, uniqueSlug } from "@/lib/text/slug";

describe("slugs", () => {
  it("slugifies names", () => {
    expect(slugify("Jamdani-Inspired Anarkali!")).toBe("jamdani-inspired-anarkali");
    expect(slugify("  Café   Crème  ")).toBe("cafe-creme");
  });

  it("makes unique ids", () => {
    expect(uniqueSlug("Front area", ["front-area", "front-area-2"])).toBe("front-area-3");
  });

  it("validates product slugs", () => {
    expect(slugSchema.safeParse("linen-wrap-dress").success).toBe(true);
    for (const bad of ["ab", "Linen Wrap", "double--hyphen", "-start", "../x"]) {
      expect(slugSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("generateSku", () => {
  it("combines product, size and color", () => {
    expect(generateSku("linen-wrap-dress", "M", "Ink Navy")).toBe("LINEN-WRAP-DRESS-M-INKNAVY");
  });
});

describe("changedFields", () => {
  it("lists only fields whose values changed", () => {
    expect(changedFields({ a: 1, b: "x", c: true }, { a: 1, b: "y", c: false })).toEqual(["b", "c"]);
  });
});
