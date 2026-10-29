import { findGarment, splitGarment, type Mask } from "@/lib/garment-photo/segment";

import { garmentFit, type GarmentFit } from "./mirror";

// The garment picture for the live mirror, prepared in the browser: cut out on a transparent background
// and measured (shoulders, waist, centre). A shop item uses its catalogue photo (cut out with the same
// code as the server, lib/garment-photo); a design uses the design screen's own recoloured picture with
// its printed items, cut out by the picture's region masks.

export type MirrorGarment = { image: HTMLCanvasElement; fit: GarmentFit };

/** Catalogue photos are cut out at this width (the server works at 400–800 px). */
const PHOTO_WIDTH = 600;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The garment picture couldn't load"));
    image.src = url;
  });
}

function canvasOf(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("2D canvas unavailable");
  return [canvas, context];
}

/** Makes every pixel outside `mask` transparent (in place). */
function applyMask(context: CanvasRenderingContext2D, mask: Mask) {
  const pixels = context.getImageData(0, 0, mask.width, mask.height);
  for (let p = 0; p < mask.width * mask.height; p += 1) {
    if (!mask.data[p]) pixels.data[p * 4 + 3] = 0;
  }
  context.putImageData(pixels, 0, 0);
}

/** A shop item's catalogue photo (signed URL): finds the garment and cuts it out. Throws if none is found. */
export async function garmentFromPhoto(url: string): Promise<MirrorGarment> {
  const image = await loadImage(url);
  const width = PHOTO_WIDTH;
  const height = Math.max(1, Math.round((image.naturalHeight * width) / Math.max(1, image.naturalWidth)));
  const [canvas, context] = canvasOf(width, height);
  context.drawImage(image, 0, 0, width, height);
  const rgba = context.getImageData(0, 0, width, height).data;
  const rgb = new Uint8Array(width * height * 3);
  for (let p = 0; p < width * height; p += 1) {
    rgb[p * 3] = rgba[p * 4] ?? 0;
    rgb[p * 3 + 1] = rgba[p * 4 + 1] ?? 0;
    rgb[p * 3 + 2] = rgba[p * 4 + 2] ?? 0;
  }
  const mask = findGarment({ data: rgb, width, height });
  const parts = splitGarment(mask);
  applyMask(context, mask);
  return { image: canvas, fit: garmentFit(parts) };
}

/** A design's recoloured picture (with its printed items) and the URLs of that picture's region masks. */
export async function garmentFromDesign(picture: HTMLCanvasElement, maskUrls: readonly string[]): Promise<MirrorGarment> {
  const { width, height } = picture;
  const [canvas, context] = canvasOf(width, height);
  context.drawImage(picture, 0, 0);
  const [, maskContext] = canvasOf(width, height);
  // Masks are white on opaque black: "lighten" keeps the union instead of each covering the last.
  maskContext.globalCompositeOperation = "lighten";
  for (const url of maskUrls) maskContext.drawImage(await loadImage(url), 0, 0, width, height);
  const maskPixels = maskContext.getImageData(0, 0, width, height).data;
  const mask: Mask = { data: new Uint8Array(width * height), width, height };
  for (let p = 0; p < width * height; p += 1) mask.data[p] = (maskPixels[p * 4] ?? 0) >= 128 ? 1 : 0;
  applyMask(context, mask);
  return { image: canvas, fit: garmentFit(splitGarment(mask)) };
}
