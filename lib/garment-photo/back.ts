import sharp from "sharp";

import { BACKDROP, PHOTO_HEIGHT, PHOTO_WIDTH } from "./align";
import type { Mask } from "./segment";

// The back of a customer's own garment (lib/own-dress), made from its front picture: there's only ever
// one photo (or drawing) of it. Seen from behind, the outline is the front's mirrored and the fabric
// (colour, folds, grain, all-over patterns) is the front's. What only the front has is painted over
// with the fabric around it, from the same part: the front neckline, mostly closed (a back neck sits
// higher), small details that stand out from the fabric (buttons, embroidery, a print), and parts
// named as front details (a pocket, a placket). Pure core (backView), sharp at the edge (backPicture).

/** Parts only the front of a garment has: on the back they become the fabric around them. */
const FRONT_ONLY = /button|pocket|placket|zip|fly\b|buckle|brooch|badge|logo|emblem|graphic|appliqu/i;

export function frontOnlyPart(label: string): boolean {
  return FRONT_ONLY.test(label);
}

/** How much of the front neckline's depth the back keeps. */
const BACK_NECK_DEPTH = 0.3;
/** The fabric around a pixel: its part's pixels within about this radius (px, three box passes). */
const FABRIC_RADIUS = 20;
/** Where there's no fabric that close (the middle of a closed neckline): within this radius. */
const WIDE_RADIUS = 80;
/**
 * A pixel this far from the fabric around it is a detail, not the fabric. Lightness counts half, so
 * folds and shadows stay; a dark button on light cloth or coloured embroidery doesn't.
 */
const DETAIL = 40;
/** How far (px) a detail's soft edge may reach, painted over with it. */
const DETAIL_EDGE = 6;
/** Details over more than this share of a part are its fabric's own pattern, kept. */
const PATTERN_SHARE = 0.12;

export type BackView = {
  /** RGB on the studio backdrop, same size as the front. */
  rgb: Uint8Array;
  /** The garment on the back, soft-edged (grey, 0–255). */
  garment: Uint8Array;
  /** Each part's grey mask on the back, in the parts' order; null for a part only the front has. */
  alphas: (Uint8Array | null)[];
};

function mirrorRows(src: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = (y * width + x) * channels;
      const to = (y * width + (width - 1 - x)) * channels;
      for (let c = 0; c < channels; c += 1) out[to + c] = src[from + c] ?? 0;
    }
  }
  return out;
}

/** Three box-blur passes in place (close to a Gaussian); unnormalised at the edges, so only use it in ratios. */
function blur(values: Float32Array, width: number, height: number, radius: number): Float32Array {
  const tmp = new Float32Array(values.length);
  for (let pass = 0; pass < 3; pass += 1) {
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      let sum = 0;
      for (let x = 0; x < Math.min(radius, width); x += 1) sum += values[row + x] ?? 0;
      for (let x = 0; x < width; x += 1) {
        if (x + radius < width) sum += values[row + x + radius] ?? 0;
        if (x - radius - 1 >= 0) sum -= values[row + x - radius - 1] ?? 0;
        tmp[row + x] = sum;
      }
    }
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let y = 0; y < Math.min(radius, height); y += 1) sum += tmp[y * width + x] ?? 0;
      for (let y = 0; y < height; y += 1) {
        if (y + radius < height) sum += tmp[(y + radius) * width + x] ?? 0;
        if (y - radius - 1 >= 0) sum -= tmp[(y - radius - 1) * width + x] ?? 0;
        values[y * width + x] = sum / (2 * radius + 1) ** 2;
      }
    }
  }
  return values;
}

/** The weighted average colour around each pixel of a window: [r, g, b, weight] planes. */
function fabricAround(rgb: Float32Array[], weight: Float32Array, width: number, height: number, radius: number): Float32Array[] {
  const planes = rgb.map((plane) => blur(plane.map((v, p) => v * (weight[p] ?? 0)), width, height, radius));
  return [...planes, blur(Float32Array.from(weight), width, height, radius)];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** How far a colour is from another, lightness counting half (see DETAIL). */
function detailDistance(r: number, g: number, b: number, r2: number, g2: number, b2: number): number {
  const light = 0.299 * (r - r2) + 0.587 * (g - g2) + 0.114 * (b - b2);
  const redGreen = r - g - (r2 - g2);
  const yellowBlue = (r + g) / 2 - b - ((r2 + g2) / 2 - b2);
  return Math.hypot(light / 2, redGreen, yellowBlue);
}

/**
 * The back of a garment from its front: `rgb` is the front on the studio backdrop, `garmentAlpha` where
 * the garment is on it, `alphas` its parts' grey masks (all the same size), `frontOnly` which parts only
 * the front has.
 */
export function backView(
  rgb: Uint8Array,
  width: number,
  height: number,
  garmentAlpha: Uint8Array,
  alphas: readonly Uint8Array[],
  frontOnly: readonly boolean[],
): BackView {
  const n = width * height;
  const out = mirrorRows(rgb, width, height, 3);
  const garment = mirrorRows(garmentAlpha, width, height, 1);
  const parts = alphas.map((a) => mirrorRows(a, width, height, 1));
  // When every part is front-only there's nothing to fold them into: keep them all.
  const kept = parts.map((_, i) => !frontOnly[i] || frontOnly.every(Boolean));
  /** Pixels painted over with the fabric around them. */
  const repaint = new Uint8Array(n);

  // Each garment pixel's part: the one most present there. A front-only part's pixels, and garment the
  // (coarser) part masks miss, go to the nearest kept part; a front-only part's mask joins that one.
  const most = new Int16Array(n).fill(-1);
  for (let p = 0; p < n; p += 1) {
    let bestA = 0;
    for (const [i, part] of parts.entries()) {
      const a = part[p] ?? 0;
      if (a > bestA) {
        most[p] = i;
        bestA = a;
      }
    }
  }
  const nearestKept = (x: number, y: number): number => {
    for (let d = 1; d < Math.max(width, height); d += 1) {
      for (const [cx, cy] of [[x - d, y], [x + d, y], [x, y - d], [x, y + d]] as const) {
        if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue;
        const o = most[cy * width + cx] ?? -1;
        if (o >= 0 && kept[o]) return o;
      }
    }
    return -1;
  };
  const owner = Int16Array.from(most);
  for (let p = 0; p < n; p += 1) {
    const o = most[p] ?? -1;
    if (o >= 0 && kept[o]) continue;
    if (o < 0 && (garment[p] ?? 0) === 0) continue;
    const into = nearestKept(p % width, Math.floor(p / width));
    owner[p] = into;
    if (o < 0 || into < 0) continue;
    repaint[p] = 1;
    const target = parts[into];
    if (target) target[p] = Math.max(target[p] ?? 0, parts[o]?.[p] ?? 0);
  }

  // The neckline: between the highest point of each shoulder, the back keeps BACK_NECK_DEPTH of the
  // front's dip, filled from the part just below.
  let bx0 = width;
  let bx1 = -1;
  let by0 = height;
  let by1 = -1;
  for (let p = 0; p < n; p += 1) {
    if ((garment[p] ?? 0) < 128) continue;
    const x = p % width;
    const y = Math.floor(p / width);
    bx0 = Math.min(bx0, x);
    bx1 = Math.max(bx1, x);
    by0 = Math.min(by0, y);
    by1 = Math.max(by1, y);
  }
  if (bx1 > bx0 && by1 > by0) {
    const top = new Int32Array(width).fill(-1);
    for (let x = bx0; x <= bx1; x += 1) {
      for (let y = by0; y <= by1; y += 1) {
        if ((garment[y * width + x] ?? 0) >= 128) {
          top[x] = y;
          break;
        }
      }
    }
    const shoulderBand = by0 + Math.round(0.35 * (by1 - by0));
    const centre = Math.round((bx0 + bx1) / 2);
    // The highest point on each side; on a tie, the one nearest the middle (the neck side of the shoulder).
    const peak = (from: number, to: number, step: number) => {
      let best = -1;
      for (let x = from; step > 0 ? x <= to : x >= to; x += step) {
        const t = top[x] ?? -1;
        if (t >= 0 && t <= shoulderBand && (best < 0 || t < (top[best] ?? 0))) best = x;
      }
      return best;
    };
    const left = peak(centre, bx0, -1);
    const right = peak(centre, bx1, 1);
    if (left >= 0 && right > left) {
      const lt = top[left] ?? 0;
      const rt = top[right] ?? 0;
      for (let x = left + 1; x < right; x += 1) {
        const t = top[x] ?? -1;
        if (t < 0) continue;
        const line = lt + ((rt - lt) * (x - left)) / (right - left);
        const depth = t - line;
        if (depth <= 2) continue;
        const newTop = Math.round(line + BACK_NECK_DEPTH * depth);
        const into = owner[Math.min(height - 1, t + 3) * width + x] ?? -1;
        const part = into >= 0 ? parts[into] : undefined;
        if (!part) continue;
        for (let y = newTop; y <= Math.min(height - 1, t + 2); y += 1) {
          const p = y * width + x;
          const a = y === newTop ? 140 : 255;
          repaint[p] = 1;
          part[p] = Math.max(part[p] ?? 0, a);
          garment[p] = Math.max(garment[p] ?? 0, a);
          owner[p] = into;
        }
      }
    }
  }

  // Each kept part: details that stand out from the fabric around them join the pixels to paint over
  // (twice, as a big detail pulls its surroundings towards it), then those are painted with the fabric
  // around them, in a window around the part.
  for (const [i] of parts.entries()) {
    if (!kept[i]) continue;
    let x0 = width;
    let x1 = -1;
    let y0 = height;
    let y1 = -1;
    for (let p = 0; p < n; p += 1) {
      if (owner[p] !== i || (garment[p] ?? 0) === 0) continue;
      x0 = Math.min(x0, p % width);
      x1 = Math.max(x1, p % width);
      y0 = Math.min(y0, Math.floor(p / width));
      y1 = Math.max(y1, Math.floor(p / width));
    }
    if (x1 < x0) continue;
    const ww = x1 - x0 + 1;
    const wh = y1 - y0 + 1;
    const at = (wx: number, wy: number) => (y0 + wy) * width + x0 + wx;
    const planes = [0, 1, 2].map((c) => {
      const plane = new Float32Array(ww * wh);
      for (let wy = 0; wy < wh; wy += 1) for (let wx = 0; wx < ww; wx += 1) plane[wy * ww + wx] = out[at(wx, wy) * 3 + c] ?? 0;
      return plane;
    });
    const weight = new Float32Array(ww * wh);
    for (let wy = 0; wy < wh; wy += 1) {
      for (let wx = 0; wx < ww; wx += 1) {
        const p = at(wx, wy);
        if (owner[p] === i && (garment[p] ?? 0) >= 200 && !repaint[p]) weight[wy * ww + wx] = 1;
      }
    }
    const pixel = (w: number) => [planes[0]?.[w] ?? 0, planes[1]?.[w] ?? 0, planes[2]?.[w] ?? 0] as const;
    const fabricPixels = weight.reduce((m, v) => m + v, 0);
    const details = new Uint8Array(ww * wh);
    let detailCount = 0;
    for (let round = 0; round < 3; round += 1) {
      const [r, g, b, sum] = fabricAround(planes, weight, ww, wh, FABRIC_RADIUS);
      for (let w = 0; w < ww * wh; w += 1) {
        const s = sum?.[w] ?? 0;
        if (!weight[w] || s < 1e-3) continue;
        if (detailDistance(...pixel(w), (r?.[w] ?? 0) / s, (g?.[w] ?? 0) / s, (b?.[w] ?? 0) / s) > DETAIL) {
          weight[w] = 0;
          details[w] = 1;
          detailCount += 1;
        }
      }
    }
    // So much stands out that it's the fabric's own pattern, all over the garment (the back has it too).
    if (detailCount > fabricPixels * PATTERN_SHARE) {
      for (let w = 0; w < ww * wh; w += 1) if (details[w]) weight[w] = 1;
    } else {
      // With its soft edge (an embroidery's halo): fabric next to a detail that's still half as far off.
      const [r, g, b, sum] = fabricAround(planes, weight, ww, wh, FABRIC_RADIUS);
      for (let step = 0; step < DETAIL_EDGE; step += 1) {
        const grown: number[] = [];
        for (let w = 0; w < ww * wh; w += 1) {
          const s = sum?.[w] ?? 0;
          if (!weight[w] || s < 1e-3) continue;
          const x = w % ww;
          const nextToDetail = (x > 0 && details[w - 1]) || (x < ww - 1 && details[w + 1]) || details[w - ww] || details[w + ww];
          if (nextToDetail && detailDistance(...pixel(w), (r?.[w] ?? 0) / s, (g?.[w] ?? 0) / s, (b?.[w] ?? 0) / s) > DETAIL / 2) grown.push(w);
        }
        if (grown.length === 0) break;
        for (const w of grown) {
          details[w] = 1;
          weight[w] = 0;
        }
      }
      for (let w = 0; w < ww * wh; w += 1) if (details[w]) repaint[at(w % ww, Math.floor(w / ww))] = 1;
    }
    const fabric: number[][] = [[], [], []];
    for (let w = 0; w < ww * wh; w += 1) if (weight[w]) pixel(w).forEach((v, c) => fabric[c]?.push(v));
    const plain = fabric.map(median);
    const near = fabricAround(planes, weight, ww, wh, FABRIC_RADIUS);
    const wide = fabricAround(planes, weight, ww, wh, WIDE_RADIUS);
    for (let w = 0; w < ww * wh; w += 1) {
      const p = at(w % ww, Math.floor(w / ww));
      if (owner[p] !== i || !repaint[p]) continue;
      const around = (near[3]?.[w] ?? 0) > 1e-3 ? near : wide;
      const s = around[3]?.[w] ?? 0;
      const a = (garment[p] ?? 0) / 255;
      for (let c = 0; c < 3; c += 1) {
        const colour = s > 1e-3 ? (around[c]?.[w] ?? 0) / s : (plain[c] ?? 0);
        const backdrop = c === 0 ? BACKDROP.r : c === 1 ? BACKDROP.g : BACKDROP.b;
        out[p * 3 + c] = Math.max(0, Math.min(255, Math.round(colour * a + backdrop * (1 - a))));
      }
    }
  }

  return { rgb: out, garment, alphas: parts.map((part, i) => (kept[i] ? part : null)) };
}

/**
 * The back picture of a customer's own garment from its framed front (any image format, the full
 * picture size), where the garment is on it (grey PNG) and its parts' grey PNG masks: the WebP picture,
 * and the back mask (grey PNG + working size) of each part the back has.
 */
export async function backPicture(
  front: Buffer,
  garmentAlpha: Buffer,
  parts: readonly { id: string; label: string; png: Buffer }[],
): Promise<{ image: Buffer; masks: { id: string; png: Buffer; work: Mask }[] }> {
  const size = { width: PHOTO_WIDTH, height: PHOTO_HEIGHT };
  const rgb = await sharp(front).resize(size.width, size.height, { fit: "fill" }).removeAlpha().raw().toBuffer();
  // (.raw() would expand a grey PNG to three channels: take the one.)
  const grey = (png: Buffer) => sharp(png).resize(size.width, size.height, { fit: "fill" }).extractChannel(0).raw().toBuffer();
  const [garment, ...alphas] = await Promise.all([grey(garmentAlpha), ...parts.map((part) => grey(part.png))]);
  const view = backView(
    new Uint8Array(rgb),
    size.width,
    size.height,
    new Uint8Array(garment ?? Buffer.alloc(size.width * size.height)),
    alphas.map((a) => new Uint8Array(a)),
    parts.map((part) => frontOnlyPart(part.label)),
  );
  const image = await sharp(Buffer.from(view.rgb), { raw: { ...size, channels: 3 } })
    .webp({ quality: 90 })
    .toBuffer();
  const workW = 400;
  const workH = Math.round((workW * PHOTO_HEIGHT) / PHOTO_WIDTH);
  const masks = [];
  for (const [i, alpha] of view.alphas.entries()) {
    const part = parts[i];
    if (!alpha || !part) continue;
    const png = await sharp(Buffer.from(alpha), { raw: { ...size, channels: 1 } })
      .toColourspace("b-w")
      .png({ compressionLevel: 9 })
      .toBuffer();
    const small = await sharp(png).resize(workW, workH, { fit: "fill" }).extractChannel(0).raw().toBuffer();
    masks.push({ id: part.id, png, work: { data: Uint8Array.from(small, (v) => (v >= 128 ? 1 : 0)), width: workW, height: workH } });
  }
  return { image, masks };
}
