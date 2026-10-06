import { describe, expect, it } from "vitest";

import { DEFAULT_TEMPLATE_CONFIG } from "@/prisma/seed-data";
import { templateConfigSchema } from "@/types/template";

describe("templateConfigSchema", () => {
  it("accepts the seeded default template", () => {
    expect(templateConfigSchema.safeParse(DEFAULT_TEMPLATE_CONFIG).success).toBe(true);
  });

  it("rejects duplicate region/area ids, bad colors and negative add-on prices", () => {
    const dup = { ...DEFAULT_TEMPLATE_CONFIG, regions: [...DEFAULT_TEMPLATE_CONFIG.regions, DEFAULT_TEMPLATE_CONFIG.regions[0]] };
    expect(templateConfigSchema.safeParse(dup).success).toBe(false);

    const badColor = { ...DEFAULT_TEMPLATE_CONFIG, allowedColors: [{ name: "Bad", hex: "red" }] };
    expect(templateConfigSchema.safeParse(badColor).success).toBe(false);

    const negative = {
      ...DEFAULT_TEMPLATE_CONFIG,
      styleOptions: {
        ...DEFAULT_TEMPLATE_CONFIG.styleOptions,
        neckline: [{ id: "round", label: "Round", addOnPriceMinor: -1 }],
      },
    };
    expect(templateConfigSchema.safeParse(negative).success).toBe(false);
  });

  it("rejects unknown schema versions", () => {
    expect(templateConfigSchema.safeParse({ ...DEFAULT_TEMPLATE_CONFIG, schemaVersion: 2 }).success).toBe(false);
  });
});
