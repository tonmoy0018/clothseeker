import { describe, expect, it } from "vitest";

import { assignParts, pairName, partKind, separableHints, type PartHint } from "@/lib/garment-photo/parts";
import { emptyMask, maskArea, type Mask, type RgbImage } from "@/lib/garment-photo/segment";

// A customer's own garment split into ITS parts from the AI's boxes and colours: colour separates parts
// whose boxes overlap, the shape-based split and the smaller box decide where colours match, and what
// lies outside every box isn't garment.

const W = 100;
const H = 120;

type Paint = (x: number, y: number) => readonly [number, number, number] | null;

/** A drawn photo: the garment mask is wherever `paint` returns a colour. */
function drawn(paint: Paint): { image: RgbImage; garment: Mask } {
  const data = new Uint8Array(W * H * 3).fill(240);
  const garment = emptyMask(W, H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const c = paint(x, y);
      if (!c) continue;
      data.set(c, (y * W + x) * 3);
      garment.data[y * W + x] = 1;
    }
  }
  return { image: { data, width: W, height: H }, garment };
}

const noShapes = { sleeves: emptyMask(W, H), bodice: emptyMask(W, H), skirt: emptyMask(W, H) };
const box = (left: number, top: number, right: number, bottom: number) => ({ left: left / W, top: top / H, right: right / W, bottom: bottom / H });
const at = (mask: Mask | undefined, x: number, y: number) => mask?.data[y * W + x] === 1;

describe("splitting a customer's garment into its own parts", () => {
  it("tells a white shirt from the open black jacket around it, and drops what's outside every box", () => {
    const BLACK = [20, 20, 22] as const;
    const WHITE = [228, 226, 222] as const;
    const SKIN = [235, 225, 210] as const;
    const { image, garment } = drawn((x, y) => {
      if (y < 12 && Math.abs(x - 50) < 6) return SKIN; // a mannequin's neck above the garment
      if (y >= 12 && y < 100 && x >= 20 && x < 80) return Math.abs(x - 50) < 10 && y < 85 ? WHITE : BLACK;
      return null;
    });
    const hints: PartHint[] = [
      { label: "Jacket body", box: box(20, 12, 80, 100), hex: "#151515" },
      { label: "Inner shirt", box: box(38, 12, 62, 85), hex: "#e4e2de" },
    ];
    const { parts, garment: kept } = assignParts(image, garment, noShapes, hints);
    expect(at(parts[1], 50, 40)).toBe(true); // shirt
    expect(at(parts[0], 30, 40)).toBe(true); // jacket beside it
    expect(at(parts[0], 45, 40)).toBe(false); // inside the shirt's box but white: shirt, not jacket
    expect(at(parts[0], 50, 92)).toBe(true); // below the shirt: jacket
    expect(at(kept, 50, 5)).toBe(false); // the mannequin's neck isn't garment
  });

  it("where colours match, the parts' names and the shape-based split decide", () => {
    const OLIVE = [140, 154, 61] as const;
    const { image, garment } = drawn((x, y) => (y >= 10 && y < 110 && x >= 25 && x < 75 ? OLIVE : null));
    const shapes = { sleeves: emptyMask(W, H), bodice: emptyMask(W, H), skirt: emptyMask(W, H) };
    for (let y = 10; y < 110; y += 1) for (let x = 25; x < 75; x += 1) (y < 45 ? shapes.bodice : shapes.skirt).data[y * W + x] = 1;
    const hints: PartHint[] = [
      { label: "Bodice", box: box(25, 10, 75, 50), hex: "#8c9a3d" },
      { label: "Skirt", box: box(25, 40, 75, 110), hex: "#8c9a3d" },
    ];
    const { parts } = assignParts(image, garment, shapes, hints);
    expect(at(parts[0], 50, 42)).toBe(true); // in both boxes: the shape says bodice
    expect(at(parts[1], 50, 47)).toBe(true);
    expect(maskArea(parts[0] ?? emptyMask(W, H)) + maskArea(parts[1] ?? emptyMask(W, H))).toBe(maskArea(garment));
  });

  it("folds a small same-colour part into its surroundings, but keeps a band across them", () => {
    const skirt = { label: "Bodice", box: box(25, 10, 75, 50), hex: "#8c9a3d" };
    expect(separableHints([skirt, { label: "Neck tie", box: box(45, 10, 55, 30), hex: "#8c9a3d" }])).toEqual([true, false]);
    expect(separableHints([skirt, { label: "Waistband", box: box(25, 44, 75, 49), hex: "#8c9a3d" }])).toEqual([true, true]);
    // A different colour is told apart by its colour.
    expect(separableHints([skirt, { label: "Neck tie", box: box(45, 10, 55, 30), hex: "#f2e6c9" }])).toEqual([true, true]);
  });

  it("names the two sides of a pair as one part", () => {
    expect(pairName("Left sleeve")).toBe("Sleeves");
    expect(pairName("right cuff")).toBe("Cuffs");
    expect(pairName("Left patch")).toBe("Patches");
    expect(pairName("Right lapels")).toBe("Lapels");
    // Not one side of a pair.
    expect(pairName("Sleeves")).toBeNull();
    expect(pairName("Leftover trim")).toBeNull();
    expect(pairName("Left")).toBeNull();
  });

  it("knows which named parts the shape-based split can help with", () => {
    expect(partKind("Puff sleeves")).toBe("sleeves");
    expect(partKind("Shoulder straps")).toBe("sleeves");
    expect(partKind("Ruffle tiers")).toBe("skirt");
    expect(partKind("Jacket body")).toBe("bodice");
    expect(partKind("Lapels")).toBeNull();
  });
});
