import sharp from "sharp";

/** A pencil drawing of a strappy dress: a black outline on white paper (a customer's sketch). */
export async function sketchDrawing(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800">
    <rect width="600" height="800" fill="#ffffff"/>
    <path d="M240 120 L260 60 M360 120 L340 60 M240 120 L360 120 L350 330 L470 720 L130 720 L250 330 Z" fill="none" stroke="#222222" stroke-width="5"/>
    <path d="M255 330 L345 330" stroke="#222222" stroke-width="3"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
