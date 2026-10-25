import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";

import { normalizeForRender, pictureWidthCm } from "@/lib/design/normalize";
import { priceDesign } from "@/lib/design/pricing";
import { validateDesignAgainstTemplate } from "@/lib/design/validate";
import { renderPreview, renderPrintFiles, storageAssets, type Assets } from "@/lib/renderer/render";
import { BUCKETS } from "@/lib/storage/buckets";
import { designSpecSchema } from "@/types/design-spec";

import { CONTEXT, KEYS, storageWithTemplateAssets, TEMPLATE, validSpec } from "../fixtures/design";

// All-over prints: a decoration or the customer's own image repeated across a whole part.

let assets: Assets;
beforeAll(async () => {
  const storage = await storageWithTemplateAssets();
  const logo = await sharp({ create: { width: 200, height: 200, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 1 } } }).webp().toBuffer();
  await storage.put(BUCKETS.designAssets, KEYS.upload, logo, "image/webp");
  assets = storageAssets(storage);
});

const starPrint = { kind: "decoration" as const, id: "star" as const, color: "#1b1b1b", tileCm: 6 };

describe("all-over prints", () => {
  it("validates: allowed decoration and colour, the customer's own image, never with a pattern", () => {
    expect(validateDesignAgainstTemplate(validSpec({ parts: { skirt: { color: "#f5f5f0", print: starPrint } } }), TEMPLATE, CONTEXT)).toEqual([]);
    const theirs = validSpec({ parts: { skirt: { color: "#f5f5f0", print: { kind: "image", assetKey: KEYS.upload, tileCm: 10 } } } });
    expect(validateDesignAgainstTemplate(theirs, TEMPLATE, CONTEXT)).toEqual([]);
    const someoneElses = validSpec({ parts: { skirt: { color: "#f5f5f0", print: { kind: "image", assetKey: KEYS.upload, tileCm: 10 } } } });
    expect(validateDesignAgainstTemplate(someoneElses, TEMPLATE, { ...CONTEXT, customerId: "6c7d8e9f-3333-4444-8555-666677778888" }).map((i) => i.path)).toEqual(["parts.skirt.print"]);
    expect(validateDesignAgainstTemplate(validSpec({ parts: { skirt: { color: "#f5f5f0", print: { ...starPrint, color: "#123456" } } } }), TEMPLATE, CONTEXT).map((i) => i.path)).toEqual([
      "parts.skirt.print.color",
    ]);
    const both = { ...validSpec(), parts: { skirt: { color: "#f5f5f0", pattern: { id: "stripes", color: "#1b1b1b" }, print: starPrint } } };
    expect(designSpecSchema.safeParse(both).success).toBe(false);
    expect(designSpecSchema.safeParse({ ...validSpec(), parts: { skirt: { color: "#f5f5f0", print: { ...starPrint, tileCm: 1 } } } }).success).toBe(false);
  });

  it("is priced like a pattern, once per part", () => {
    const spec = validSpec({ parts: { skirt: { color: "#f5f5f0", print: starPrint }, bodice: { color: "#f5f5f0", print: starPrint } } });
    const line = priceDesign(spec, TEMPLATE, 300_000).lines.find((l) => l.label.startsWith("All-over print"));
    expect(line).toEqual({ label: "All-over print × 2", amountMinor: 2 * TEMPLATE.addOns.patternMinor });
  });

  it("repeats the motif across the part in the preview, sized from the tile's cm", async () => {
    const spec = validSpec({ layers: [], parts: { skirt: { color: "#f5f5f0", print: starPrint } } });
    const plan = normalizeForRender(spec, TEMPLATE);
    expect(plan.front.fills[0]?.print?.tile).toBeCloseTo(6 / pictureWidthCm(TEMPLATE), 3);
    const preview = await renderPreview(plan, "front", assets);
    // Stars on a pale skirt: the skirt band holds both dark and light pixels.
    const { data, info } = await sharp(preview).extract({ left: 420, top: 1050, width: 360, height: 200 }).greyscale().raw().toBuffer({ resolveWithObject: true });
    const values = [...data.subarray(0, info.width * info.height)];
    expect(Math.min(...values)).toBeLessThan(90);
    expect(Math.max(...values)).toBeGreaterThan(200);
  });

  it("gives production one repeat at real size", async () => {
    const spec = validSpec({ layers: [], parts: { skirt: { color: "#f5f5f0", print: { kind: "image", assetKey: KEYS.upload, tileCm: 10 } } } });
    const files = await renderPrintFiles(normalizeForRender(spec, TEMPLATE), assets);
    expect(files.map((f) => [f.areaId, f.widthCm, f.heightCm])).toEqual([["print-skirt", 10, 10]]);
    expect(files[0]?.label).toBe("Skirt all-over print (repeats every 10 cm)");
    expect(files[0]?.widthPx).toBe(1181); // 10 cm at 300 DPI
  });
});
