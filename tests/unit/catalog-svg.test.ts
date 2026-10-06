import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { DECORATION_IDS, decorationSvg } from "@/lib/catalog/decorations";
import { PATTERN_IDS, patternSvg } from "@/lib/catalog/patterns";

describe("curated SVG builders", () => {
  it.each(PATTERN_IDS)("pattern %s renders at the requested size", async (id) => {
    const svg = patternSvg(id, "#ffffff", "#1f6f50", 300, 200, 40);
    const meta = await sharp(Buffer.from(svg)).metadata();
    expect([meta.width, meta.height]).toEqual([300, 200]);
  });

  it.each(DECORATION_IDS)("decoration %s renders as a square", async (id) => {
    const meta = await sharp(Buffer.from(decorationSvg(id, "#e8a0b4", 120))).metadata();
    expect([meta.width, meta.height]).toEqual([120, 120]);
  });

  it("refuses anything but a hex color, so nothing can be injected into the SVG", () => {
    expect(() => patternSvg("stripes", '"/><script>alert(1)</script>', "#000000", 10, 10, 4)).toThrow("Invalid color");
    expect(() => decorationSvg("star", "red")).toThrow("Invalid color");
  });
});
