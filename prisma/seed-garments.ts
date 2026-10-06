import sharp from "sharp";

// Neutral garment silhouettes used as template base images for the seeded dresses.
// Our own trusted SVG (never user input), rasterized to WebP at 1200×1560.

const OUTLINE = 'stroke="#9a9a9a" stroke-width="2.2" stroke-linejoin="round"';

const FRONT = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 260" width="1200" height="1560">
  <rect width="200" height="260" fill="#ffffff"/>
  <path d="M82 18 L88 18 L91 44 L109 44 L112 18 L118 18 L124 52 L128 100 L170 238 Q100 256 30 238 L72 100 L76 52 Z" fill="#ececec" ${OUTLINE}/>
  <path d="M72 100 Q100 108 128 100" fill="none" ${OUTLINE}/>
</svg>`;

const BACK = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 260" width="1200" height="1560">
  <rect width="200" height="260" fill="#ffffff"/>
  <path d="M82 18 L88 18 L92 30 L108 30 L112 18 L118 18 L124 52 L128 100 L170 238 Q100 256 30 238 L72 100 L76 52 Z" fill="#e4e4e4" ${OUTLINE}/>
  <path d="M72 100 Q100 108 128 100" fill="none" ${OUTLINE}/>
  <path d="M100 30 L100 100" fill="none" stroke="#b5b5b5" stroke-width="1.5" stroke-dasharray="3 3"/>
</svg>`;

export async function renderGarment(side: "front" | "back"): Promise<Buffer> {
  return sharp(Buffer.from(side === "front" ? FRONT : BACK)).webp({ quality: 90 }).toBuffer();
}
