import sharp from "sharp";

// A catalogue-like photo for decoration cut-outs: a pale backdrop, a navy garment with soft shading, and
// on it a red diamond with near-white stitches (as pale as the backdrop).

const W = 400;
const H = 400;

/** A box around the diamond, inside the garment. */
export const DECORATED_BOX = { x: 0.505, y: 0.38, w: 0.24, h: 0.24 };

export async function decoratedPhoto(): Promise<Buffer> {
  const data = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      let rgb: [number, number, number] = [240, 240, 238];
      if (x >= 100 && x < 300 && y >= 30 && y < 390) {
        const shade = 1 + 0.12 * Math.sin(x / 9);
        rgb = [Math.round(28 * shade), Math.round(42 * shade), Math.round(92 * shade)];
        // Off the middle column, where the garment finder samples the dress colour.
        const dx = Math.abs(x - 250);
        const dy = Math.abs(y - 200);
        if (dx + dy < 34) rgb = [200, 30, 45];
        if ((dx === 12 || dx === 13 || dx === 14) && (dy === 12 || dy === 13 || dy === 14)) rgb = [246, 246, 244];
      }
      data.set(rgb, (y * W + x) * 3);
    }
  }
  return sharp(data, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}
