import { describe, expect, it } from "vitest";

import { applyFabricField, fabricField } from "@/lib/design/fabric-warp";

// Printed items take the fabric's shape: shading from its light, bending along folds, wrapping at the
// sides of the body. Checked on small synthetic garments.

const W = 120;
const H = 80;

/** A grey garment over columns 20–99 (fabric mask), with a darker vertical fold at x 55–64. */
function garment(fold: boolean) {
  const rgb = new Uint8Array(W * H * 3);
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const p = y * W + x;
      const onFabric = x >= 20 && x < 100;
      mask[p] = onFabric ? 255 : 0;
      const value = !onFabric ? 230 : fold && x >= 55 && x < 65 ? 90 : 170;
      rgb.fill(value, p * 3, p * 3 + 3);
    }
  }
  return { rgb, mask };
}

/** Flat layers: a white vertical bar at x 40–43, opaque. */
function bar() {
  const layers = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    for (let x = 40; x < 44; x += 1) layers.set([255, 255, 255, 255], (y * W + x) * 4);
  }
  return layers;
}

const alphaAt = (out: Uint8Array, x: number, y: number) => out[(y * W + x) * 4 + 3] ?? 0;
const redAt = (out: Uint8Array, x: number, y: number) => out[(y * W + x) * 4] ?? 0;

describe("fabric field", () => {
  it("leaves the centre of a flat garment nearly as it is, and pushes prints outward towards the edges", () => {
    const { rgb, mask } = garment(false);
    const field = fabricField(rgb, 3, mask, 1, W, H);
    const centre = 40 * W + 60;
    expect(Math.abs((field.sourceX[centre] ?? 0) - 60)).toBeLessThan(0.5);
    expect(field.shade[centre]).toBeCloseTo(1, 1);
    // Near the right edge the flat print is sampled from further out: it looks compressed (wrapped).
    expect(field.sourceX[40 * W + 95]).toBeGreaterThan(95.5);
    // Off the fabric nothing moves.
    expect(field.sourceX[40 * W + 5]).toBe(5);
    expect(field.shade[40 * W + 5]).toBe(1);
  });

  it("darkens prints in the fold and bends them near it", () => {
    const plain = garment(false);
    const creased = garment(true);
    const flat = fabricField(plain.rgb, 3, plain.mask, 1, W, H);
    const folded = fabricField(creased.rgb, 3, creased.mask, 1, W, H);
    expect(folded.shade[40 * W + 60]).toBeLessThan(0.8);
    // Next to the fold, the sampling position shifts (the slope of the smoothed brightness).
    expect(Math.abs((folded.sourceX[40 * W + 54] ?? 0) - (flat.sourceX[40 * W + 54] ?? 0))).toBeGreaterThan(0.3);
  });

  it("applies shading to the layers' colour and keeps transparent areas transparent", () => {
    const { rgb, mask } = garment(true);
    const field = fabricField(rgb, 3, mask, 1, W, H);
    const layers = new Uint8Array(W * H * 4);
    for (let y = 30; y < 50; y += 1) for (let x = 50; x < 70; x += 1) layers.set([200, 200, 200, 255], (y * W + x) * 4);
    const out = new Uint8Array(W * H * 4);
    applyFabricField(layers, out, field);
    expect(redAt(out, 60, 40)).toBeLessThan(170); // in the fold: darker than the flat 200
    expect(alphaAt(out, 10, 10)).toBe(0);
    // The same input always gives the same pixels.
    const again = new Uint8Array(W * H * 4);
    applyFabricField(layers, again, fabricField(rgb, 3, mask, 1, W, H));
    expect(Buffer.from(again).equals(Buffer.from(out))).toBe(true);
  });

  it("moves a print only a little", () => {
    const { rgb, mask } = garment(true);
    const out = new Uint8Array(W * H * 4);
    applyFabricField(bar(), out, fabricField(rgb, 3, mask, 1, W, H));
    // The bar is still there, within a few pixels of where it was.
    const row = 40;
    const columns = [...Array(W).keys()].filter((x) => alphaAt(out, x, row) > 128);
    expect(columns.length).toBeGreaterThan(0);
    expect(Math.min(...columns)).toBeGreaterThanOrEqual(36);
    expect(Math.max(...columns)).toBeLessThanOrEqual(47);
  });
});
