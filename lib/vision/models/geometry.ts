// Fitting a camera frame or photo into a model's square input without distorting it (letterboxing),
// and mapping model coordinates back to the source. Pure, so it is shared by the browser and tests.

export type FitBox = {
  /** The model's square input size in pixels. */
  size: number;
  /** Source pixels → model pixels. */
  scale: number;
  /** Where the scaled source sits inside the square (the rest is black padding). */
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
};

export function fitSquare(sourceWidth: number, sourceHeight: number, size: number): FitBox {
  const scale = size / Math.max(sourceWidth, sourceHeight, 1);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  return { size, scale, offsetX: Math.floor((size - width) / 2), offsetY: Math.floor((size - height) / 2), width, height };
}

/**
 * Like fitSquare, into a width×height rectangle (a model that takes the frame's own shape): the source
 * keeps its proportions, centred, with black padding. `size` is the longer side.
 */
export function fitRect(sourceWidth: number, sourceHeight: number, width: number, height: number): FitBox {
  const scale = Math.min(width / Math.max(sourceWidth, 1), height / Math.max(sourceHeight, 1));
  const w = Math.max(1, Math.round(sourceWidth * scale));
  const h = Math.max(1, Math.round(sourceHeight * scale));
  return { size: Math.max(width, height), scale, offsetX: Math.floor((width - w) / 2), offsetY: Math.floor((height - h) / 2), width: w, height: h };
}

/** A point in model pixels → the same point in source pixels. */
export function toSource(box: FitBox, x: number, y: number): [number, number] {
  return [(x - box.offsetX) / box.scale, (y - box.offsetY) / box.scale];
}

/**
 * Nearest-neighbour letterbox of an RGBA image into a size×size RGBA square (black padding). The browser
 * uses a canvas for this; tests and Node use this.
 */
export function letterboxRgba(source: ArrayLike<number>, sourceWidth: number, sourceHeight: number, box: FitBox): Uint8ClampedArray {
  const out = new Uint8ClampedArray(box.size * box.size * 4);
  for (let p = 3; p < out.length; p += 4) out[p] = 255;
  for (let y = 0; y < box.height; y += 1) {
    const sy = Math.min(sourceHeight - 1, Math.floor((y + 0.5) / box.scale));
    for (let x = 0; x < box.width; x += 1) {
      const sx = Math.min(sourceWidth - 1, Math.floor((x + 0.5) / box.scale));
      const from = (sy * sourceWidth + sx) * 4;
      const to = ((y + box.offsetY) * box.size + x + box.offsetX) * 4;
      out[to] = source[from] ?? 0;
      out[to + 1] = source[from + 1] ?? 0;
      out[to + 2] = source[from + 2] ?? 0;
    }
  }
  return out;
}
