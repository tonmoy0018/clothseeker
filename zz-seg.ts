import sharp from "sharp";
import { findGarment, splitGarment, sleeveReach, lengthRatio } from "./lib/garment-photo/segment";
async function main() {
  const [out, ...files] = process.argv.slice(2);
  const W = 400;
  const tiles: Buffer[] = [];
  for (const f of files) {
    const { data, info } = await sharp(f!).resize(W, W).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const img = { data: new Uint8Array(data), width: info.width, height: info.height };
    try {
      const parts = splitGarment(findGarment(img));
      console.log(f!.split("/").pop(), "reach", sleeveReach(parts).toFixed(2), "len", lengthRatio(parts).toFixed(2), { s: parts.shoulderY, h: parts.hemY, sw: parts.shoulderWidth });
      const o = Buffer.from(data);
      for (let i = 0; i < W * W; i++) {
        const c = parts.sleeves.data[i] ? [230, 60, 60] : parts.bodice.data[i] || parts.skirt.data[i] ? [60, 160, 60] : null;
        if (c) for (let k = 0; k < 3; k++) o[i * 3 + k] = Math.round(o[i * 3 + k]! * 0.35 + c[k]! * 0.65);
      }
      tiles.push(await sharp(o, { raw: { width: W, height: W, channels: 3 } }).png().toBuffer());
    } catch (e) { console.log(f, "FAILED", (e as Error).message); tiles.push(await sharp(f!).resize(W, W).png().toBuffer()); }
  }
  await sharp({ create: { width: W * tiles.length, height: W, channels: 3, background: "#fff" } }).composite(tiles.map((t, i) => ({ input: t, left: i * W, top: 0 }))).png().toFile(out!);
}
void main();
