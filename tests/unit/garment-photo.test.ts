import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { alignPhoto, analysePhoto, PHOTO_HEIGHT, PHOTO_WIDTH, SHOULDER_Y, TORSO } from "@/lib/garment-photo/align";
import { maskArea, skirtRatio, sleeveStyle } from "@/lib/garment-photo/segment";
import { luminance, shadeFactor, shadeRange } from "@/lib/design/shade";

// Synthetic catalogue photos: a dress (with soft vertical folds) on a cream mannequin and stand, on a
// grey studio gradient. Checks that the dress is found and split, and that styles are read back.

type Synthetic = { colour: string; sleeves: "sleeveless" | "short" | "long"; hem: number };

async function photo({ colour, sleeves, hem }: Synthetic): Promise<Buffer> {
  // 400×400 drawing; shoulders at y 90, waist at 170.
  const sleeve =
    sleeves === "short"
      ? `<path d="M160 92 L132 140 L152 150 L168 120 Z" fill="${colour}"/><path d="M240 92 L268 140 L248 150 L232 120 Z" fill="${colour}"/>`
      : sleeves === "long"
        ? `<path d="M160 92 L138 120 L128 250 L144 252 L158 140 Z" fill="${colour}"/><path d="M240 92 L262 120 L272 250 L256 252 L242 140 Z" fill="${colour}"/>`
        : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e4e4e2"/><stop offset="1" stop-color="#cfcfcd"/></linearGradient>
    <linearGradient id="fold" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity="0.25"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.15"/><stop offset="1" stop-color="#000" stop-opacity="0.25"/></linearGradient></defs>
    <rect width="400" height="400" fill="url(#bg)"/>
    <rect x="196" y="${hem}" width="8" height="${396 - hem}" fill="#b08a5a"/>
    <ellipse cx="200" cy="80" rx="18" ry="22" fill="#efe3cc"/>
    <path d="M160 90 L185 86 Q200 100 215 86 L240 90 L236 170 L164 170 Z" fill="${colour}"/>
    <path d="M164 170 L236 170 L${255 + (hem - 300) * 0.2} ${hem} L${145 - (hem - 300) * 0.2} ${hem} Z" fill="${colour}"/>
    <path d="M164 170 L236 170 L${255 + (hem - 300) * 0.2} ${hem} L${145 - (hem - 300) * 0.2} ${hem} Z" fill="url(#fold)"/>
    ${sleeve}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

describe("finding and splitting the dress in a photo", () => {
  it("finds dark and pale dresses, without the mannequin or its stand", async () => {
    for (const colour of ["#1f2a44", "#cfe8d8", "#b9a6d9", "#1b1b1b"]) {
      const { parts } = await analysePhoto(await photo({ colour, sleeves: "sleeveless", hem: 300 }));
      expect(parts.shoulderY, colour).toBeGreaterThanOrEqual(84);
      expect(parts.shoulderY, colour).toBeLessThanOrEqual(92);
      expect(parts.hemY, colour).toBeGreaterThanOrEqual(295);
      expect(parts.hemY, colour).toBeLessThanOrEqual(303); // the stand below the hem isn't dress
      expect(Math.abs(parts.waistY - 170), colour).toBeLessThanOrEqual(12); // within 3% of the picture
    }
  });

  it("reads sleeves: none, short, and long ones hanging beside the skirt", async () => {
    for (const sleeves of ["sleeveless", "short", "long"] as const) {
      const { parts } = await analysePhoto(await photo({ colour: "#722f37", sleeves, hem: 320 }));
      expect(sleeveStyle(parts), sleeves).toBe(sleeves);
      expect(maskArea(parts.sleeves) > 0, sleeves).toBe(sleeves !== "sleeveless");
      // Parts never overlap and together make up the dress.
      expect(maskArea(parts.sleeves) + maskArea(parts.bodice) + maskArea(parts.skirt)).toBe(maskArea(parts.garment));
    }
  });

  it("orders skirt lengths mini < midi < maxi", async () => {
    const ratios = [];
    for (const hem of [250, 310, 380]) {
      ratios.push(skirtRatio((await analysePhoto(await photo({ colour: "#1f6f50", sleeves: "short", hem }))).parts));
    }
    expect(ratios[0]).toBeLessThan(ratios[1] ?? 0);
    expect(ratios[1]).toBeLessThan(ratios[2] ?? 0);
  });

  it("lines photos up: shoulders and waist land at the same height whatever the original framing", async () => {
    const original = await photo({ colour: "#1f2a44", sleeves: "short", hem: 330 });
    // The same dress, smaller and off-centre.
    const shifted = await sharp({ create: { width: 400, height: 400, channels: 3, background: "#dadad8" } })
      .composite([{ input: await sharp(original).resize(300, 300).toBuffer(), left: 0, top: 60 }])
      .jpeg()
      .toBuffer();
    for (const input of [original, shifted]) {
      const aligned = await alignPhoto(input);
      expect(await sharp(aligned).metadata()).toMatchObject({ width: PHOTO_WIDTH, height: PHOTO_HEIGHT });
      const { parts, scale } = await analysePhoto(aligned);
      expect(Math.abs((parts.shoulderY * scale) / PHOTO_HEIGHT - SHOULDER_Y)).toBeLessThan(0.02);
      expect(Math.abs(((parts.waistY - parts.shoulderY) * scale) / PHOTO_HEIGHT - TORSO)).toBeLessThan(0.025);
      expect(Math.abs((parts.centreX * scale) / PHOTO_WIDTH - 0.5)).toBeLessThan(0.02);
    }
  });
});

describe("recolouring photos (shade)", () => {
  it("stretches the fabric's own light and shade over the new colour", () => {
    // A dark navy region: brightness 0.10–0.30, with a mask.
    const rgb = [20, 25, 50, 60, 70, 110, 40, 45, 80, 200, 200, 200];
    const mask = [255, 255, 255, 0];
    const range = shadeRange(rgb, 3, mask, 1);
    expect(range.low).toBeCloseTo(luminance(20, 25, 50), 1);
    expect(range.high).toBeCloseTo(luminance(60, 70, 110), 1);
    // Darkest fabric → deep shadow, brightest → full colour; a pale pink stays pale.
    expect(shadeFactor(range.low, range)).toBeCloseTo(0.45);
    expect(shadeFactor(range.high, range)).toBeCloseTo(1.05);
    expect(shadeFactor(1, range)).toBeCloseTo(1.05);
  });

  it("copes with flat fabric (black) without dividing by zero", () => {
    const range = shadeRange([10, 10, 10, 10, 10, 10], 3, [255, 255], 1);
    expect(range.high - range.low).toBeGreaterThan(0.05);
    expect(Number.isFinite(shadeFactor(0.04, range))).toBe(true);
  });
});
