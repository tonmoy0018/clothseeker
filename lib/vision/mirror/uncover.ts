import { armChain, type BodyAnchors } from "./mirror";

// The person's own clothes where the garment doesn't cover them: a T-shirt's sleeves and shoulders
// around a sleeveless dress, its neckline inside a low one. Left alone they show the garment as a
// cut-out pasted over other clothes. On the shoulders, upper chest and arms they become skin (the
// colour read from the face, shaded like the cloth was lit); beside the body (a sleeve standing off the
// arm) they become the backdrop next to them. Pure (on pixel arrays), so it is unit-tested; the browser
// runs it on a half-size copy of each frame, before the garment is drawn over it.

/** A person's skin colour, in YCbCr (0–255) and RGB. */
export type SkinModel = { y: number; cb: number; cr: number; rgb: [number, number, number] };

function ycbcr(r: number, g: number, b: number): [number, number, number] {
  return [0.299 * r + 0.587 * g + 0.114 * b, 128 - 0.1687 * r - 0.3313 * g + 0.5 * b, 128 + 0.5 * r - 0.4187 * g - 0.0813 * b];
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

/**
 * The skin colour around the nose (a disc as wide as the eyes are apart), from the pixels that could be
 * skin at all; null when too few are seen (a face too small or turned away). `scale`: camera pixels per
 * pixel of `rgba`; the face points are in camera pixels.
 */
export function skinModel(rgba: ArrayLike<number>, width: number, height: number, scale: number, face: NonNullable<BodyAnchors["face"]>): SkinModel | null {
  const radius = Math.hypot(face.leftEye.x - face.rightEye.x, face.leftEye.y - face.rightEye.y) * 0.8;
  const cx = face.nose.x / scale;
  const cy = face.nose.y / scale;
  const r = radius / scale;
  const samples: { y: number; cb: number; cr: number; rgb: [number, number, number] }[] = [];
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(height - 1, Math.ceil(cy + r)); y += 1) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(width - 1, Math.ceil(cx + r)); x += 1) {
      if (Math.hypot(x - cx, y - cy) > r) continue;
      const p = (y * width + x) * 4;
      const rgb: [number, number, number] = [rgba[p] ?? 0, rgba[p + 1] ?? 0, rgba[p + 2] ?? 0];
      const [Y, cb, cr] = ycbcr(...rgb);
      // Any human skin tone, broadly; leaves out eyes, brows, nostrils and lips' darkest parts.
      if (Y < 40 || Y > 245 || cb < 75 || cb > 135 || cr < 130 || cr > 185) continue;
      samples.push({ y: Y, cb, cr, rgb });
    }
  }
  if (samples.length < 12) return null;
  return {
    y: median(samples.map((s) => s.y)),
    cb: median(samples.map((s) => s.cb)),
    cr: median(samples.map((s) => s.cr)),
    rgb: [median(samples.map((s) => s.rgb[0])), median(samples.map((s) => s.rgb[1])), median(samples.map((s) => s.rgb[2]))],
  };
}

/** How far a colour's tint is from this person's skin: up to 1 is their skin, in shadow or light. */
export function skinDistance(skin: SkinModel, r: number, g: number, b: number): number {
  const [y, cb, cr] = ycbcr(r, g, b);
  if (y < skin.y * 0.3 || y > skin.y * 1.7) return Infinity;
  return Math.hypot((cb - skin.cb) / SKIN_TINT, (cr - skin.cr) / SKIN_TINT);
}

/** How much a person's skin tint varies over their body (YCbCr units): shadows, light, redder arms. */
const SKIN_TINT = 18;

/** Whether a colour is this person's skin (any shade of it). */
export function isSkin(skin: SkinModel, r: number, g: number, b: number): boolean {
  return skinDistance(skin, r, g, b) <= 1;
}

/**
 * Below this share of the person mask, a pixel is the backdrop. Down to FRINGE, its clothes' colour can
 * still show at the outline (the mask is coarse), so those pixels are painted too.
 */
const BACKDROP = 0.3;
const FRINGE = 0.05;

/**
 * How far clothes stand off the body at its outline (a share of the shoulder-joint distance): that band
 * of the person's own clothes becomes backdrop, the rest skin.
 */
export const STAND_OFF = 0.05;
/** Half a bare arm's width, as a share of the shoulder-joint distance (a sleeve standing off it becomes backdrop). */
export const ARM_HALF = 0.13;
/** Over this share of the torso's length below the upper chest, painted skin fades out. */
const CHEST_FADE = 0.08;

/**
 * An RGBA overlay (same size as `rgba`; transparent where nothing changes) that turns the person's own
 * clothes on their shoulders, upper chest and arms into skin where the bare body would be (shoulders
 * sloping from the neck, arms ARM_HALF wide, inside the outline by STAND_OFF), and the rest (a sleeve
 * standing off the arm) into the backdrop beside it. The torso below the chest is left for the garment. The head, everything
 * below the hips (trousers under a short dress), dark hair near the head and what is already skin or
 * backdrop are left alone. `person` is the person mask at a camera pixel; `scale` is camera pixels per
 * pixel of `rgba`.
 */
export function uncoverOwnClothes(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  scale: number,
  body: BodyAnchors,
  person: (x: number, y: number) => number,
  skin: SkinModel,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(width * height * 4);
  const joints = { x: (body.leftShoulder.x + body.rightShoulder.x) / 2, y: (body.leftShoulder.y + body.rightShoulder.y) / 2 };
  const hips = { x: (body.leftHip.x + body.rightHip.x) / 2, y: (body.leftHip.y + body.rightHip.y) / 2 };
  const span = Math.hypot(body.leftShoulder.x - body.rightShoulder.x, body.leftShoulder.y - body.rightShoulder.y);
  const torso = Math.hypot(hips.x - joints.x, hips.y - joints.y);
  if (span < 4 || torso < 4) return out;
  const down = { x: (hips.x - joints.x) / torso, y: (hips.y - joints.y) / torso };
  const across = { x: (body.leftShoulder.x - body.rightShoulder.x) / span, y: (body.leftShoulder.y - body.rightShoulder.y) / span };

  // Only around the upper body and arms.
  const points = [body.leftShoulder, body.rightShoulder, body.leftHip, body.rightHip, ...armChain(body, "left"), ...armChain(body, "right")];
  const margin = span * 0.6;
  const x0 = Math.max(0, Math.floor((Math.min(...points.map((p) => p.x)) - margin) / scale));
  const x1 = Math.min(width - 1, Math.ceil((Math.max(...points.map((p) => p.x)) + margin) / scale));
  const y0 = Math.max(0, Math.floor((Math.min(...points.map((p) => p.y)) - margin) / scale));
  const y1 = Math.min(height - 1, Math.ceil(Math.max(...points.map((p) => p.y)) / scale));
  if (x1 < x0 || y1 < y0) return out;

  // The backdrop beside each pixel: on the side where the person's outline is nearest, the nearest
  // column that is clearly backdrop (past the mask's soft edge), a little further out. -1 when there's
  // none on the row. `edgeDistance`: camera pixels to the outline.
  // The person mask, read once per pixel worked on (the area reaches well past the person, so the
  // backdrop is found inside it).
  const personAt = new Float32Array(width * height);
  for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) personAt[y * width + x] = person((x + 0.5) * scale, (y + 0.5) * scale);
  const maskAt = (x: number, y: number) => personAt[y * width + x] ?? 0;
  const backdropAt = new Int32Array(width * height).fill(-1);
  const edgeDistance = new Float32Array(width * height).fill(Infinity);
  const edgeBefore = new Int32Array(width);
  const edgeAfter = new Int32Array(width);
  const clearBefore = new Int32Array(width);
  const clearAfter = new Int32Array(width);
  for (let y = y0; y <= y1; y += 1) {
    let edge = -1;
    let clear = -1;
    for (let x = x0; x <= x1; x += 1) {
      const m = maskAt(x, y);
      if (m < BACKDROP) edge = x;
      if (m < FRINGE) clear = x;
      edgeBefore[x] = edge;
      clearBefore[x] = clear;
    }
    edge = -1;
    clear = -1;
    for (let x = x1; x >= x0; x -= 1) {
      const m = maskAt(x, y);
      if (m < BACKDROP) edge = x;
      if (m < FRINGE) clear = x;
      edgeAfter[x] = edge;
      clearAfter[x] = clear;
    }
    for (let x = x0; x <= x1; x += 1) {
      const l = edgeBefore[x] ?? -1;
      const r = edgeAfter[x] ?? -1;
      const toLeft = l < 0 ? Infinity : x - l;
      const toRight = r < 0 ? Infinity : r - x;
      const cl = clearBefore[x] ?? -1;
      const cr = clearAfter[x] ?? -1;
      const column = (toLeft <= toRight && cl >= 0) || cr < 0 ? (cl < 0 ? -1 : Math.max(0, cl - 1)) : Math.min(width - 1, cr + 1);
      if (column >= 0) backdropAt[y * width + x] = y * width + column;
      edgeDistance[y * width + x] = Math.min(toLeft, toRight) * scale;
    }
  }

  /** Half the bare upper body's width at this depth (beside the arms): from the neck sloping out to the shoulders. */
  const bodyHalf = (depth: number) => (depth < -span * 0.08 ? span * (0.15 + (0.35 * (depth + span * 0.3)) / (span * 0.22)) : span * 0.5);
  /** Where the upper chest ends: below it the garment covers the body, and the person's clothes are left. */
  const armpits = torso * 0.3;
  const arms = [armChain(body, "left"), armChain(body, "right")];
  const armHalf = span * ARM_HALF;
  /**
   * Distance from the nearest arm's centre line, as a share of a bare arm's half-width, and whether
   * that's the forearm or hand (below the elbow, where no sleeve stands off the arm).
   */
  const onArm = (p: { x: number; y: number }) => {
    let best = Infinity;
    let forearm = false;
    for (const chain of arms) {
      for (let k = 1; k < chain.length; k += 1) {
        const a = chain[k - 1] ?? p;
        const b = chain[k] ?? p;
        const abx = b.x - a.x;
        const aby = b.y - a.y;
        const t = Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.y - a.y) * aby) / Math.max(1e-9, abx * abx + aby * aby)));
        const d = Math.hypot(p.x - a.x - abx * t, p.y - a.y - aby * t) / armHalf;
        if (d < best) {
          best = d;
          forearm = k >= 2;
        }
      }
    }
    return { distance: best, forearm };
  };
  const [skinY] = ycbcr(...skin.rgb);
  // 1: painted (skin, backdrop, or a blend of the two by `bareWeight`).
  const kind = new Uint8Array(width * height);
  const luma = new Float32Array(width * height);
  const bareWeight = new Float32Array(width * height);
  const armSide = new Float32Array(width * height);
  const strength = new Float32Array(width * height);
  const bodySkin: [number, number, number][] = [];
  let lumaSum = 0;
  let lumaCount = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const p = { x: (x + 0.5) * scale, y: (y + 0.5) * scale };
      const depth = (p.x - joints.x) * down.x + (p.y - joints.y) * down.y;
      if (depth < -span * 0.3 || depth > torso || maskAt(x, y) < FRINGE) continue;
      const i = y * width + x;
      const colour: [number, number, number] = [rgba[i * 4] ?? 0, rgba[i * 4 + 1] ?? 0, rgba[i * 4 + 2] ?? 0];
      const tint = skinDistance(skin, ...colour);
      if (tint <= 1) {
        // The body's own visible skin (neck, arms) gives the paint its colour: a face is often lit
        // brighter than the rest.
        if (bodySkin.length < 6000) bodySkin.push(colour);
        continue;
      }
      const from = backdropAt[i] ?? -1;
      const edge = edgeDistance[i] ?? Infinity;
      const [Y] = ycbcr(...colour);
      const lateral = (p.x - joints.x) * across.x + (p.y - joints.y) * across.y;
      // Dark hair falling over the shoulders stays.
      if (Y < skinY * 0.5 && depth < torso * 0.5 && Math.abs(lateral) < span * 0.4) continue;
      const arm = onArm(p);
      // Below the upper chest the body is the garment's to cover: its own clothes are left (painting
      // skin there would show a bare torso wherever a garment doesn't reach).
      // The paint fades out over a short band, so a low neckline shows no edge.
      const chest = arm.distance > 1 && Math.abs(lateral) <= span * 0.6;
      if (chest && depth >= armpits + CHEST_FADE * torso) continue;
      const fade = chest ? Math.min(1, (armpits + CHEST_FADE * torso - depth) / (CHEST_FADE * torso)) : 1;
      // Forearms and hands: their own shaded edges stay; only clearly clothed parts (a long sleeve)
      // become skin, never backdrop.
      const forearm = arm.forearm && arm.distance <= 2;
      if (forearm && tint < 1.6) continue;
      // How far inside the bare body this pixel is (camera pixels; negative outside it), blended over
      // about a pixel of `rgba` either side so the boundary isn't stepped.
      const upper = depth < armpits + CHEST_FADE * torso ? bodyHalf(depth) - Math.abs(lateral) : -Infinity;
      const inside = Math.min(Math.max(upper, (1 - arm.distance) * armHalf), edge - span * STAND_OFF);
      const weight = from < 0 || forearm ? 1 : Math.min(1, Math.max(0, 0.5 + inside / (scale * 2)));
      if (from >= 0 && edge < span * 0.12) {
        const wall: [number, number, number] = [rgba[from * 4] ?? 0, rgba[from * 4 + 1] ?? 0, rgba[from * 4 + 2] ?? 0];
        // On the body's edge: the backdrop (the person mask is coarse and reaches past the body), or
        // skin blended with it, stays as it is. Where the backdrop is painted anyway, only what's
        // nearly backdrop stays (repainting it would show the backdrop's own shading as specks).
        const nearWall = distanceToSegment(colour, wall, wall);
        if (weight >= 0.5 ? nearWall < 24 || distanceToSegment(colour, skin.rgb, wall) < 14 : nearWall < 12) continue;
      }
      kind[i] = 1;
      bareWeight[i] = weight;
      // Nearly skin (a tint just outside the person's range) is only partly painted, so borderline
      // pixels of real skin don't turn into blotches.
      strength[i] = (weight >= 0.5 ? Math.min(1, (tint - 1) * 2) : 1) * fade;
      // Only beside the torso does an arm's roundness show.
      armSide[i] = Math.abs(lateral) > bodyHalf(depth) && arm.distance < 1 ? arm.distance : 0;
      luma[i] = Y;
      if (weight > 0) {
        lumaSum += Y;
        lumaCount += 1;
      }
    }
  }
  const meanLuma = lumaCount > 0 ? lumaSum / lumaCount : 1;
  const paint: readonly number[] = bodySkin.length >= 40 ? [0, 1, 2].map((c) => median(bodySkin.map((rgb) => rgb[c] ?? 0))) : skin.rgb;

  for (let i = 0; i < width * height; i += 1) {
    if (kind[i] !== 1) continue;
    // The cloth's light and folds, softened, so painted skin is lit like the rest of the person; it
    // darkens towards the body's outline, where it turns away from the camera.
    const light = Math.min(1.12, Math.max(0.8, 1 + ((luma[i] ?? meanLuma) / meanLuma - 1) * 0.35));
    // Darker towards the outline, and towards an arm's sides.
    const inward = Math.min(1, ((edgeDistance[i] ?? Infinity) - span * STAND_OFF) / (span * 0.15));
    const sides = Math.max(1 - Math.max(0, inward), armSide[i] ?? 0);
    const round = 1 - 0.25 * sides * sides;
    const weight = bareWeight[i] ?? 1;
    const from = backdropAt[i] ?? -1;
    for (let c = 0; c < 3; c += 1) {
      const wall = from < 0 ? 0 : (rgba[from * 4 + c] ?? 0);
      out[i * 4 + c] = Math.round((paint[c] ?? 0) * light * round * weight + wall * (1 - weight));
    }
    out[i * 4 + 3] = Math.round(255 * (strength[i] ?? 1));
  }

  // Soft edges (inside only, where the colour is known), so painted areas blend into the real skin and
  // backdrop around them.
  const alpha = new Uint8ClampedArray(width * height);
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const i = y * width + x;
      if (!out[i * 4 + 3]) continue;
      // Backdrop-coloured paint meets the real backdrop: no softening needed (it would show the
      // clothes' fringe through).
      if ((bareWeight[i] ?? 1) < 0.5) {
        alpha[i] = out[i * 4 + 3] ?? 0;
        continue;
      }
      let sum = 0;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) sum += out[((y + dy) * width + x + dx) * 4 + 3] ?? 0;
      alpha[i] = Math.round(sum / 9);
    }
  }
  for (let i = 0; i < width * height; i += 1) out[i * 4 + 3] = alpha[i] ?? 0;
  return out;
}

/** RGB distance from a colour to the line segment between two colours. */
function distanceToSegment(c: readonly number[], a: readonly number[], b: readonly number[]): number {
  const ab = [0, 1, 2].map((k) => (b[k] ?? 0) - (a[k] ?? 0));
  const ac = [0, 1, 2].map((k) => (c[k] ?? 0) - (a[k] ?? 0));
  const len = ab.reduce((s, v) => s + v * v, 0);
  const t = len > 0 ? Math.min(1, Math.max(0, ab.reduce((s, v, k) => s + v * (ac[k] ?? 0), 0) / len)) : 0;
  return Math.hypot(...ac.map((v, k) => v - (ab[k] ?? 0) * t));
}
