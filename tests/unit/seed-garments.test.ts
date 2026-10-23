import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { DEFAULT_TEMPLATE_CONFIG } from "@/lib/catalog/default-template";
import { renderGarment, renderMask, SEED_REGIONS, SEED_SKIRT_AREA, SEED_STYLE_IDS, seedStyles, type GarmentStyle, type SeedRegion, type Side } from "@/prisma/seed-garments";

// The seeded style pictures must work for every style: print areas stay on the fabric (so nothing is
// printed onto a neckline opening or past a mini hem), and the regions never overlap.

const WIDTH = 200; // one pixel per drawing unit keeps this fast
const HEIGHT = 260;

const AREA_REGION: Record<string, SeedRegion> = { "front-chest": "bodice", "front-skirt": "skirt", "back-upper": "bodice" };
const areas = DEFAULT_TEMPLATE_CONFIG.placementAreas.map((a) => (a.id === "front-skirt" ? { ...a, ...SEED_SKIRT_AREA } : a));

async function maskPixels(side: Side, style: GarmentStyle, region: SeedRegion): Promise<Buffer> {
  return sharp(await renderMask(side, style, region, WIDTH)).extractChannel(0).raw().toBuffer();
}

function pictures(): { side: Side; style: GarmentStyle }[] {
  return seedStyles().flatMap((style) => [{ side: "front" as const, style }, ...(style.neckline === SEED_STYLE_IDS.neckline[0] ? [{ side: "back" as const, style }] : [])]);
}

describe("seeded style pictures", () => {
  it("draws all 27 front styles and 9 back styles", () => {
    const list = pictures();
    expect(list.filter((p) => p.side === "front")).toHaveLength(27);
    expect(list.filter((p) => p.side === "back")).toHaveLength(9);
  });

  it("keeps every print area on its region's fabric, for every style", async () => {
    for (const { side, style } of pictures()) {
      for (const area of areas.filter((a) => a.side === side)) {
        const region = AREA_REGION[area.id];
        if (!region) throw new Error(`No region for ${area.id}`);
        const mask = await maskPixels(side, style, region);
        const x0 = Math.ceil(area.rect.x * WIDTH);
        const x1 = Math.floor((area.rect.x + area.rect.w) * WIDTH) - 1;
        const y0 = Math.ceil(area.rect.y * HEIGHT);
        const y1 = Math.floor((area.rect.y + area.rect.h) * HEIGHT) - 1;
        const outside: string[] = [];
        for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1], [Math.round((x0 + x1) / 2), y0]] as const) {
          if ((mask[y * WIDTH + x] ?? 0) < 200) outside.push(`${x},${y}`);
        }
        expect(outside, `${area.id} on ${side} ${JSON.stringify(style)}`).toEqual([]);
      }
    }
  });

  it("never lets two regions claim the same pixel", async () => {
    for (const { side, style } of pictures()) {
      const masks = await Promise.all(SEED_REGIONS.map((r) => maskPixels(side, style, r.id)));
      let overlap = 0;
      for (let i = 0; i < WIDTH * HEIGHT; i += 1) {
        if (masks.filter((m) => (m[i] ?? 0) > 200).length > 1) overlap += 1;
      }
      expect(overlap, `${side} ${JSON.stringify(style)}`).toBe(0);
    }
  });

  it("changes the picture when the style changes, and the hem rises from maxi to mini", async () => {
    const style = { neckline: "round", sleeveLength: "short", dressLength: "midi" };
    const [a, b] = await Promise.all([renderGarment("front", style, WIDTH), renderGarment("front", { ...style, neckline: "v-neck" }, WIDTH)]);
    expect(a.equals(b)).toBe(false);

    const lowestSkirtRow = async (dressLength: string) => {
      const mask = await maskPixels("front", { ...style, dressLength }, "skirt");
      for (let y = HEIGHT - 1; y >= 0; y -= 1) {
        if ((mask[y * WIDTH + WIDTH / 2] ?? 0) > 200) return y;
      }
      return -1;
    };
    const [mini, midi, maxi] = await Promise.all(["mini", "midi", "maxi"].map(lowestSkirtRow));
    expect(mini).toBeLessThan(midi ?? 0);
    expect(midi).toBeLessThan(maxi ?? 0);
  });

  it("only sleeved styles have sleeves in the sleeves & straps region", async () => {
    const count = async (sleeveLength: string) => (await maskPixels("front", { neckline: "round", sleeveLength, dressLength: "midi" }, "straps")).filter((v) => v > 200).length;
    const [none, short, long] = await Promise.all(["sleeveless", "short", "long"].map(count));
    expect(short).toBeGreaterThan(none ?? 0);
    expect(long).toBeGreaterThan(short ?? 0);
  });
});
