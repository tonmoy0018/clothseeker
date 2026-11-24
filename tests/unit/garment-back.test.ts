import { describe, expect, it } from "vitest";

import { BACKDROP } from "@/lib/garment-photo/align";
import { backView, frontOnlyPart } from "@/lib/garment-photo/back";

// A 60×80 front: a blue body from y=10 with a neckline notch down to y=30 between x=24 and 35, a block
// sticking out on its right (x 50–54) to tell the sides apart, a red pocket on its left, and the left
// half slightly darker than the right, and a dark button (not a part of its own) on the right.
const W = 60;
const H = 80;

function front() {
  const rgb = new Uint8Array(W * H * 3);
  const body = new Uint8Array(W * H);
  const pocket = new Uint8Array(W * H);
  const garment = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const p = y * W + x;
      const inBody = (x >= 10 && x < 50 && y >= 10 && y < 70 && !(x >= 24 && x < 36 && y < 30)) || (x >= 50 && x < 55 && y >= 50 && y < 60);
      const inPocket = x >= 12 && x < 18 && y >= 40 && y < 46;
      const inButton = x >= 40 && x < 43 && y >= 50 && y < 53;
      const colour = inPocket ? [200, 30, 30] : inButton ? [15, 15, 20] : inBody ? (x < 30 ? [30, 90, 190] : [50, 110, 210]) : [BACKDROP.r, BACKDROP.g, BACKDROP.b];
      rgb.set(colour, p * 3);
      if (inPocket || inBody) garment[p] = 255;
      if (inPocket) pocket[p] = 255;
      else if (inBody) body[p] = 255;
    }
  }
  return { rgb, garment, body, pocket };
}

const at = (rgb: Uint8Array, x: number, y: number) => [rgb[(y * W + x) * 3] ?? 0, rgb[(y * W + x) * 3 + 1] ?? 0, rgb[(y * W + x) * 3 + 2] ?? 0] as const;
const lum = ([r, g, b]: readonly [number, number, number]) => 0.299 * r + 0.587 * g + 0.114 * b;

describe("the back of a customer's own garment", () => {
  it("is the front's outline seen from behind (mirrored)", () => {
    const { rgb, garment, body, pocket } = front();
    const [backBody] = backView(rgb, W, H, garment, [body, pocket], [false, true]).alphas;
    if (!backBody) throw new Error("no body on the back");
    expect(backBody[55 * W + 7]).toBe(255);
    expect(backBody[55 * W + 52]).toBe(0);
  });

  it("closes most of the front neckline", () => {
    const { rgb, garment, body, pocket } = front();
    const view = backView(rgb, W, H, garment, [body, pocket], [false, true]);
    const backBody = view.alphas[0];
    if (!backBody) throw new Error("no body on the back");
    // Mirrored, the notch is x 24–35 still; the back keeps 30% of its 20 px depth: its top is about y=16.
    expect(backBody[18 * W + 29]).toBe(255);
    expect(backBody[14 * W + 29]).toBe(0);
    // Filled with the fabric, not the backdrop.
    const [r, g, b] = at(view.rgb, 29, 20);
    expect(b).toBeGreaterThan(r + 80);
    expect(g).toBeGreaterThan(r + 30);
  });

  it("leaves out what only the front has (a pocket), in the fabric around it", () => {
    const { rgb, garment, body, pocket } = front();
    const view = backView(rgb, W, H, garment, [body, pocket], [false, true]);
    expect(view.alphas[1]).toBeNull();
    // The pocket was at x 12–17 on the front: x 42–47 on the back.
    expect(view.alphas[0]?.[42 * W + 44]).toBe(255);
    const [r, , b] = at(view.rgb, 44, 42);
    expect(b).toBeGreaterThan(150);
    expect(r).toBeLessThan(80);
  });

  it("keeps the fabric's light and shade, mirrored", () => {
    const { rgb, garment, body, pocket } = front();
    const view = backView(rgb, W, H, garment, [body, pocket], [false, true]);
    // The front's lighter right half is the back's left.
    expect(lum(at(view.rgb, 13, 62))).toBeGreaterThan(lum(at(view.rgb, 46, 62)) + 5);
    // Off the garment: the backdrop.
    expect(at(view.rgb, 2, 2)).toEqual([BACKDROP.r, BACKDROP.g, BACKDROP.b]);
  });

  it("paints over a detail that stands out from the fabric around it (a button)", () => {
    const { rgb, garment, body, pocket } = front();
    const view = backView(rgb, W, H, garment, [body, pocket], [false, true]);
    // The button was at x 40–42 on the front: x 17–19 on the back.
    const [r, g, b] = at(view.rgb, 18, 51);
    expect(b).toBeGreaterThan(150);
    expect(g).toBeGreaterThan(70);
    expect(r).toBeLessThan(80);
  });

  it("keeps every part when there's nothing but front-only parts", () => {
    const { rgb, garment, body } = front();
    expect(backView(rgb, W, H, garment, [body], [true]).alphas[0]).not.toBeNull();
  });

  it("knows the parts only a garment's front has", () => {
    expect(["Buttons", "Chest pocket", "Front placket", "Zip", "Logo patch"].every(frontOnlyPart)).toBe(true);
    expect(["Bodice", "Sleeves", "Collar", "Skirt", "Jacket body"].some(frontOnlyPart)).toBe(false);
  });
});
