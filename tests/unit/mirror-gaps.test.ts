import { describe, expect, it } from "vitest";

import { GapCloser } from "@/lib/vision/mirror/gaps";

// The live mirror seals thin gaps between the garment's pieces (a sleeve beside the body) with the
// garment's own colour, and leaves real spaces (between an arm and the body) open.

const W = 40;
const H = 20;

/** A layer with opaque rectangles of a colour (x0 ≤ x < x1, y0 ≤ y < y1). */
function layer(rects: { x0: number; x1: number; y0: number; y1: number; rgb: [number, number, number] }[]): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (const r of rects) {
    for (let y = r.y0; y < r.y1; y += 1) {
      for (let x = r.x0; x < r.x1; x += 1) rgba.set([...r.rgb, 255], (y * W + x) * 4);
    }
  }
  return rgba;
}

const pixel = (rgba: Uint8ClampedArray, x: number, y: number) => [...rgba.slice((y * W + x) * 4, (y * W + x) * 4 + 4)];

describe("GapCloser", () => {
  const blue: [number, number, number] = [40, 90, 200];

  it("fills a sliver between two pieces with the garment's colour", () => {
    // Body x 5–17, sleeve x 19–30: a 2-pixel gap at x 17–18.
    const out = new GapCloser().run(layer([{ x0: 5, x1: 17, y0: 2, y1: 18, rgb: blue }, { x0: 19, x1: 30, y0: 2, y1: 18, rgb: blue }]), W, H, 2);
    expect(pixel(out, 17, 10)).toEqual([...blue, 255]);
    expect(pixel(out, 18, 10)).toEqual([...blue, 255]);
  });

  it("leaves a wide space open, and never grows the garment past its outline", () => {
    // A 10-pixel space between the pieces: an arm held away from the body.
    const out = new GapCloser().run(layer([{ x0: 2, x1: 12, y0: 2, y1: 18, rgb: blue }, { x0: 22, x1: 32, y0: 2, y1: 18, rgb: blue }]), W, H, 2);
    expect(pixel(out, 17, 10)[3]).toBe(0);
    expect(pixel(out, 1, 10)[3]).toBe(0);
    expect(pixel(out, 35, 10)[3]).toBe(0);
    expect(pixel(out, 5, 0)[3]).toBe(0);
    // Inside the garment it's opaque (drawn under the garment, so it doesn't show there).
    expect(pixel(out, 5, 10)[3]).toBe(255);
  });

  it("colours a gap like the fabric on its sides, not the backdrop", () => {
    const red: [number, number, number] = [200, 30, 30];
    const out = new GapCloser().run(layer([{ x0: 5, x1: 17, y0: 2, y1: 18, rgb: red }, { x0: 18, x1: 30, y0: 2, y1: 18, rgb: red }]), W, H, 1);
    expect(pixel(out, 17, 10)).toEqual([...red, 255]);
    // A layer with nothing on it gives nothing.
    expect(new GapCloser().run(new Uint8ClampedArray(W * H * 4), W, H, 2).every((v) => v === 0)).toBe(true);
  });
});
