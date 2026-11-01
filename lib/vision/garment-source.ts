import { findGarment, splitGarment, type GarmentParts, type Mask } from "@/lib/garment-photo/segment";

import { recoverGarment } from "./garment-fill";
import { garmentFit, inSleeve, sleeveFits, withLooseSleeves, type GarmentFit, type SleeveFit } from "./mirror";
import { featherAlpha } from "./relight";

// The garment picture for the live mirror, prepared in the browser: cut out on a transparent background
// and measured (shoulders, waist, centre). A shop item uses its catalogue photo (cut out with the same
// code as the server, lib/garment-photo); a design uses the design screen's own recoloured picture with
// its printed items, cut out by the picture's region masks.

/**
 * The garment without its sleeves (`body`), and each sleeve on its own picture, so the sleeves can
 * follow the arms. All pictures share the same pixel coordinates (`fit`).
 */
export type MirrorGarment = { body: HTMLCanvasElement; sleeves: { fit: SleeveFit; image: HTMLCanvasElement }[]; fit: GarmentFit };

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

/**
 * The picture's pixels inside `keep` only. Only the edge against the backdrop (outside `garment`) is
 * softened, after its outermost pixel ring is dropped: that ring blends the garment with the photo's
 * backdrop and would show as a pale fringe. Edges between pieces (sleeve and body) stay hard, so no
 * background shows through where they join.
 */
function cutOut(source: HTMLCanvasElement, keep: (p: number) => boolean, garment: (p: number) => boolean): HTMLCanvasElement {
  const { width, height } = source;
  const [canvas, context] = canvasOf(width, height);
  context.drawImage(source, 0, 0);
  const pixels = context.getImageData(0, 0, width, height);
  const alpha = new Uint8ClampedArray(width * height);
  for (let p = 0; p < width * height; p += 1) {
    const x = p % width;
    const inner = garment(p) && (x === 0 || garment(p - 1)) && (x === width - 1 || garment(p + 1)) && (p < width || garment(p - width)) && (p + width >= width * height || garment(p + width));
    alpha[p] = inner ? 255 : 0;
  }
  featherAlpha(alpha, width, height, 1);
  for (let p = 0; p < width * height; p += 1) pixels.data[p * 4 + 3] = keep(p) ? (alpha[p] ?? 0) : 0;
  context.putImageData(pixels, 0, 0);
  return canvas;
}

/** Splits the picture into the body and its real sleeves (straps stay with the body). */
function prepare(picture: HTMLCanvasElement, parts: GarmentParts): MirrorGarment {
  const fit = garmentFit(parts);
  const { garment } = parts;
  const sleeveMask = withLooseSleeves(garment, parts.sleeves, fit);
  const sleeves = sleeveFits(sleeveMask, fit);
  const sleeveSide = (p: number, overlap = 0) => {
    if (!sleeveMask.data[p]) return null;
    const x = p % garment.width;
    return sleeves.find((s) => inSleeve(x, s.side, fit, overlap)) ?? null;
  };
  const inGarment = (p: number) => !!garment.data[p];
  return {
    fit,
    body: cutOut(picture, (p) => inGarment(p) && sleeveSide(p) === null, inGarment),
    // Each sleeve reaches 2 px into the body, so the two overlap where they join.
    sleeves: sleeves.map((sleeve) => ({ fit: sleeve, image: cutOut(picture, (p) => sleeveSide(p, 2) === sleeve, inGarment) })),
  };
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
  // The garment finder keeps only the garment's main colour; a pale placket or an embroidered collar is
  // added back, or the person's own clothes would show through them.
  const pixels = { data: rgb, width, height };
  const found = findGarment(pixels);
  const parts = splitGarment(found);
  // Down to a torso's length below the waist: plackets and embroidery can run past it. Only the pixels
  // drawn change: the shoulders, waist and sleeves are measured on the garment's main colour, or a
  // collar band would be taken for the shoulders.
  // Recovery also recolours the backdrop caught at the garment's edge; those colours go back into the picture.
  const garment = recoverGarment(pixels, found, parts.waistY * 2 - parts.shoulderY);
  const cleaned = context.getImageData(0, 0, width, height);
  for (let p = 0; p < width * height; p += 1) {
    if (!garment.data[p]) continue;
    for (let k = 0; k < 3; k += 1) cleaned.data[p * 4 + k] = rgb[p * 3 + k] ?? 0;
  }
  context.putImageData(cleaned, 0, 0);
  return prepare(canvas, { ...parts, garment });
}

/** A design's recoloured picture (with its printed items) and the URLs of that picture's region masks. */
export async function garmentFromDesign(picture: HTMLCanvasElement, maskUrls: readonly string[]): Promise<MirrorGarment> {
  const { width, height } = picture;
  const [, maskContext] = canvasOf(width, height);
  // Masks are white on opaque black: "lighten" keeps the union instead of each covering the last.
  maskContext.globalCompositeOperation = "lighten";
  for (const url of maskUrls) maskContext.drawImage(await loadImage(url), 0, 0, width, height);
  const maskPixels = maskContext.getImageData(0, 0, width, height).data;
  const mask: Mask = { data: new Uint8Array(width * height), width, height };
  for (let p = 0; p < width * height; p += 1) mask.data[p] = (maskPixels[p * 4] ?? 0) >= 128 ? 1 : 0;
  return prepare(picture, splitGarment(mask));
}
