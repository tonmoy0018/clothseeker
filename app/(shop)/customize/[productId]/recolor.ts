"use client";

import { patternSvg, type PatternId } from "@/lib/catalog/patterns";
import { luminance, shadeChannel, shadeFactor, shadeRange } from "@/lib/design/shade";

// Browser version of the server's region recolor (lib/renderer/render.ts): the region's color or
// pattern gets the mask as alpha and goes onto the garment: multiplied for drawings, or lit by the
// photo's own light and shadow for photos ("shade", lib/design/shade.ts).
// The server render is the source of truth; this is the live preview.

export type ClientFill = { maskUrl: string; color: string; pattern: { id: PatternId; color: string } | null };

const imageCache = new Map<string, Promise<HTMLImageElement>>();

export function loadImage(url: string): Promise<HTMLImageElement> {
  let cached = imageCache.get(url);
  if (!cached) {
    cached = new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous"; // signed storage URLs send CORS headers; keeps the canvas readable
      img.onload = () => resolve(img);
      img.onerror = () => {
        imageCache.delete(url);
        reject(new Error("Image failed to load"));
      };
      img.src = url;
    });
    imageCache.set(url, cached);
  }
  return cached;
}

function svgUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("Canvas is not supported");
  }
  return ctx;
}

/** Garment image with region colors applied, as a canvas `width` px wide. */
export async function composeGarment(garmentUrl: string, fills: readonly ClientFill[], width: number, recolor: "multiply" | "shade" = "multiply"): Promise<HTMLCanvasElement> {
  const garment = await loadImage(garmentUrl);
  const height = Math.round((width * garment.naturalHeight) / garment.naturalWidth);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = context2d(canvas);
  ctx.drawImage(garment, 0, 0, width, height);
  // The unpainted photo, read once: every region is shaded from the original light and shadow.
  const original = recolor === "shade" && fills.length > 0 ? ctx.getImageData(0, 0, width, height).data : null;

  for (const fill of fills) {
    const mask = await loadImage(fill.maskUrl);
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = width;
    maskCanvas.height = height;
    const maskCtx = context2d(maskCanvas);
    maskCtx.fillStyle = "#000000";
    maskCtx.fillRect(0, 0, width, height);
    maskCtx.drawImage(mask, 0, 0, width, height);
    const maskPixels = maskCtx.getImageData(0, 0, width, height).data;

    const paint = document.createElement("canvas");
    paint.width = width;
    paint.height = height;
    const paintCtx = context2d(paint);
    if (fill.pattern) {
      const pattern = await loadImage(svgUrl(patternSvg(fill.pattern.id, fill.pattern.color, fill.color, width, height, width / 16)));
      paintCtx.drawImage(pattern, 0, 0, width, height);
    } else {
      paintCtx.fillStyle = fill.color;
      paintCtx.fillRect(0, 0, width, height);
    }
    const painted = paintCtx.getImageData(0, 0, width, height);
    const range = original ? shadeRange(original, 4, maskPixels, 4) : null;
    for (let i = 0; i < painted.data.length; i += 4) {
      if (original && range) {
        const factor = shadeFactor(luminance(original[i] ?? 0, original[i + 1] ?? 0, original[i + 2] ?? 0), range);
        for (let k = 0; k < 3; k += 1) painted.data[i + k] = shadeChannel(painted.data[i + k] ?? 0, factor);
      }
      painted.data[i + 3] = maskPixels[i] ?? 0; // mask luminance → alpha
    }
    paintCtx.putImageData(painted, 0, 0);

    ctx.globalCompositeOperation = original ? "source-over" : "multiply";
    ctx.drawImage(paint, 0, 0);
    ctx.globalCompositeOperation = "source-over";
  }
  return canvas;
}

export function decorationDataUrl(svg: string): string {
  return svgUrl(svg);
}
