import { GapCloser } from "./gaps";
import { triangleTransform, type BodyAnchors, type Point, type Triangle } from "./mirror";
import { shadeFromFrame } from "./relight";
import { SELFIE_SIZE, type PersonMask } from "../models/segment";
import { skinModel, uncoverOwnClothes, type SkinModel } from "./uncover";

// Canvas drawing for the live mirror (browser only). The geometry comes from mirror.ts.

/** How far each mesh triangle is grown (pixels) so its neighbours overlap. */
const SEAM_OVERLAP = 1.3;

/**
 * Draws a picture through a triangle mesh (each triangle an affine piece). Each triangle is grown by a
 * pixel so neighbours overlap: with less, the background shows through their anti-aliased edges as
 * faint lines across the garment.
 */
export function drawMesh(context: CanvasRenderingContext2D, image: CanvasImageSource, triangles: readonly Triangle[]) {
  for (const { src, dst } of triangles) {
    const m = triangleTransform(src, dst);
    if (!m) continue;
    const cx = (dst[0].x + dst[1].x + dst[2].x) / 3;
    const cy = (dst[0].y + dst[1].y + dst[2].y) / 3;
    context.save();
    context.beginPath();
    dst.forEach((p, i) => {
      const len = Math.hypot(p.x - cx, p.y - cy) || 1;
      const x = p.x + ((p.x - cx) / len) * SEAM_OVERLAP;
      const y = p.y + ((p.y - cy) / len) * SEAM_OVERLAP;
      if (i === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.closePath();
    context.clip();
    context.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    // Only the triangle's own part of the picture, not the whole picture per triangle.
    const xs = src.map((p) => p.x);
    const ys = src.map((p) => p.y);
    const sx = Math.max(0, Math.floor(Math.min(...xs)) - 1);
    const sy = Math.max(0, Math.floor(Math.min(...ys)) - 1);
    const sw = Math.ceil(Math.max(...xs)) + 1 - sx;
    const sh = Math.ceil(Math.max(...ys)) + 1 - sy;
    if (sw > 0 && sh > 0) context.drawImage(image, sx, sy, sw, sh, sx, sy, sw, sh);
    context.restore();
  }
}

/** Reusable canvases for the person layer, so a frame allocates nothing. */
export class PersonLayer {
  private readonly maskSquare = document.createElement("canvas");
  private readonly person = document.createElement("canvas");
  private readonly arms = document.createElement("canvas");
  private maskSet = false;
  private box: PersonMask["box"] | null = null;

  constructor() {
    this.maskSquare.width = SELFIE_SIZE;
    this.maskSquare.height = SELFIE_SIZE;
  }

  /** Remembers the newest person mask (the outline model runs on every other frame). */
  setMask(mask: PersonMask) {
    const context = this.maskSquare.getContext("2d");
    if (!context) return;
    const pixels = context.createImageData(SELFIE_SIZE, SELFIE_SIZE);
    mask.alpha.forEach((a, i) => {
      pixels.data[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, (a - 0.3) / 0.4)) * 255);
    });
    context.putImageData(pixels, 0, 0);
    this.maskSet = true;
    this.box = mask.box;
  }

  /**
   * Draws the person's arms from `frame` along `paths` (camera pixels) over what's on `context`, masked
   * by the person outline (moved by `shift` when it's from an earlier frame), so arms in front of the
   * body show in front of the garment.
   */
  drawArms(context: CanvasRenderingContext2D, frame: CanvasImageSource, width: number, height: number, paths: readonly Point[][], thickness: number, shift: Point = { x: 0, y: 0 }) {
    if (!this.maskSet || !this.box || paths.every((p) => p.length < 2)) return;
    for (const canvas of [this.person, this.arms]) {
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
    }
    const person = this.person.getContext("2d");
    const arms = this.arms.getContext("2d");
    if (!person || !arms) return;
    const { scale, offsetX, offsetY } = this.box;
    person.clearRect(0, 0, width, height);
    person.globalCompositeOperation = "source-over";
    person.drawImage(this.maskSquare, -offsetX / scale + shift.x, -offsetY / scale + shift.y, SELFIE_SIZE / scale, SELFIE_SIZE / scale);
    person.globalCompositeOperation = "source-in";
    person.drawImage(frame, 0, 0, width, height);

    arms.clearRect(0, 0, width, height);
    arms.globalCompositeOperation = "source-over";
    arms.strokeStyle = "#fff";
    arms.lineCap = "round";
    arms.lineJoin = "round";
    arms.lineWidth = Math.max(8, thickness);
    for (const path of paths) {
      if (path.length < 2) continue;
      arms.beginPath();
      path.forEach((point, i) => (i === 0 ? arms.moveTo(point.x, point.y) : arms.lineTo(point.x, point.y)));
      arms.stroke();
    }
    arms.globalCompositeOperation = "source-in";
    arms.drawImage(this.person, 0, 0);
    context.drawImage(this.arms, 0, 0);
  }
}

/**
 * The camera frame with the person's own clothes, where the garment won't cover them, turned into skin
 * or backdrop (uncover.ts). Worked out on a smaller copy (UNCOVER_WIDTH wide) and laid over the frame.
 */
export class FrameCleaner {
  private readonly small = document.createElement("canvas");
  private readonly overlay = document.createElement("canvas");
  private readonly clean = document.createElement("canvas");
  private skin: SkinModel | null = null;

  /**
   * The cleaned frame, or `frame` itself when the person's skin colour or outline isn't known yet.
   * `person`: the person mask at a camera pixel.
   */
  run(frame: CanvasImageSource, width: number, height: number, body: BodyAnchors, person: ((x: number, y: number) => number) | null): CanvasImageSource {
    // Fewer pixels for a person close to the camera: about UNCOVER_SPAN pixels between the shoulders is plenty.
    const span = Math.hypot(body.leftShoulder.x - body.rightShoulder.x, body.leftShoulder.y - body.rightShoulder.y);
    const smallWidth = Math.round(Math.min(width, UNCOVER_WIDTH, Math.max(160, (width * UNCOVER_SPAN) / Math.max(1, span))));
    const smallHeight = Math.max(1, Math.round((height * smallWidth) / width));
    const scale = width / smallWidth;
    for (const canvas of [this.small, this.overlay]) {
      if (canvas.width !== smallWidth) canvas.width = smallWidth;
      if (canvas.height !== smallHeight) canvas.height = smallHeight;
    }
    const small = this.small.getContext("2d", { willReadFrequently: true });
    const overlay = this.overlay.getContext("2d");
    if (!small || !overlay || !person) return frame;
    small.drawImage(frame, 0, 0, smallWidth, smallHeight);
    const pixels = small.getImageData(0, 0, smallWidth, smallHeight).data;
    const seen = body.face ? skinModel(pixels, smallWidth, smallHeight, scale, body.face) : null;
    // The skin colour settles over frames (a blink or a hand at the face changes one frame's reading).
    if (seen) {
      const last = this.skin;
      const mix = (a: number, b: number) => (last ? a + (b - a) * 0.2 : b);
      this.skin = {
        y: mix(last?.y ?? 0, seen.y),
        cb: mix(last?.cb ?? 0, seen.cb),
        cr: mix(last?.cr ?? 0, seen.cr),
        rgb: [mix(last?.rgb[0] ?? 0, seen.rgb[0]), mix(last?.rgb[1] ?? 0, seen.rgb[1]), mix(last?.rgb[2] ?? 0, seen.rgb[2])],
      };
    }
    if (!this.skin) return frame;
    const painted = uncoverOwnClothes(pixels, smallWidth, smallHeight, scale, body, person, this.skin);
    overlay.putImageData(new ImageData(painted, smallWidth, smallHeight), 0, 0);
    if (this.clean.width !== width) this.clean.width = width;
    if (this.clean.height !== height) this.clean.height = height;
    const clean = this.clean.getContext("2d");
    if (!clean) return frame;
    clean.drawImage(frame, 0, 0, width, height);
    clean.imageSmoothingQuality = "high";
    // Softened by about a small pixel: enlarged as it is, the paint's edges otherwise show as steps.
    clean.filter = `blur(${(scale * 0.7).toFixed(2)}px)`;
    clean.drawImage(this.overlay, 0, 0, width, height);
    clean.filter = "none";
    return this.clean;
  }
}

/** The frame is cleaned at most this wide (camera frames are usually 1280), with the shoulders about UNCOVER_SPAN apart. */
const UNCOVER_WIDTH = 480;
const UNCOVER_SPAN = 60;

/**
 * Puts the garment on the camera frame so it looks worn: its pieces are drawn into their own layer, lit
 * by the camera's light (relight.ts, soft-light blend), and laid on the frame with a soft contact
 * shadow.
 */
export class GarmentCompositor {
  private readonly layer = document.createElement("canvas");
  private readonly shade = document.createElement("canvas");
  private readonly small = document.createElement("canvas");
  private readonly edge = document.createElement("canvas");
  private readonly edgeShade = document.createElement("canvas");
  private readonly gaps = document.createElement("canvas");
  private readonly closer = new GapCloser();

  /** `pieces`: each garment picture with its mesh; `span`: the distance between the shoulders (camera pixels). */
  draw(context: CanvasRenderingContext2D, frame: CanvasImageSource, width: number, height: number, pieces: readonly { image: CanvasImageSource; triangles: readonly Triangle[] }[], span: number) {
    for (const canvas of [this.layer, this.shade]) {
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
    }
    const layer = this.layer.getContext("2d");
    const shade = this.shade.getContext("2d");
    if (!layer || !shade) return;
    layer.globalCompositeOperation = "source-over";
    layer.clearRect(0, 0, width, height);
    for (const piece of pieces) drawMesh(layer, piece.image, piece.triangles);
    this.sealGaps(layer, width, height, span);

    // The camera's light, worked out on a small copy of the frame, then stretched over the garment only.
    const smallWidth = 240;
    const smallHeight = Math.max(1, Math.round((height * smallWidth) / width));
    if (this.small.width !== smallWidth) this.small.width = smallWidth;
    if (this.small.height !== smallHeight) this.small.height = smallHeight;
    const small = this.small.getContext("2d", { willReadFrequently: true });
    if (small) {
      small.drawImage(frame, 0, 0, smallWidth, smallHeight);
      const lit = shadeFromFrame(small.getImageData(0, 0, smallWidth, smallHeight).data, smallWidth, smallHeight);
      small.putImageData(new ImageData(lit, smallWidth, smallHeight), 0, 0);
      shade.globalCompositeOperation = "source-over";
      shade.clearRect(0, 0, width, height);
      shade.imageSmoothingQuality = "high";
      shade.drawImage(this.small, 0, 0, width, height);
      shade.globalCompositeOperation = "destination-in";
      shade.drawImage(this.layer, 0, 0);
      layer.globalCompositeOperation = "soft-light";
      layer.drawImage(this.shade, 0, 0);
      layer.globalCompositeOperation = "source-over";
    }

    this.roundEdges(layer, width, height);

    // Resting on the body: a soft shadow just below and around the garment.
    context.save();
    context.shadowColor = "rgba(0, 0, 0, 0.32)";
    context.shadowBlur = Math.max(4, width * 0.012);
    context.shadowOffsetY = Math.max(1, height * 0.004);
    context.drawImage(this.layer, 0, 0);
    context.restore();
  }

  /**
   * Fills thin gaps between the garment's pieces (a sleeve and the body) with the garment's own colour,
   * on a small copy where the shoulders are about GAP_SPAN pixels apart (gaps.ts), drawn under it.
   */
  private sealGaps(layer: CanvasRenderingContext2D, width: number, height: number, span: number) {
    const w = Math.max(1, Math.round(Math.min(width, GAP_MAX_WIDTH, (width * GAP_SPAN) / Math.max(1, span))));
    const h = Math.max(1, Math.round((height * w) / width));
    if (this.gaps.width !== w) this.gaps.width = w;
    if (this.gaps.height !== h) this.gaps.height = h;
    const gaps = this.gaps.getContext("2d", { willReadFrequently: true });
    if (!gaps) return;
    gaps.clearRect(0, 0, w, h);
    gaps.imageSmoothingQuality = "high";
    gaps.drawImage(this.layer, 0, 0, w, h);
    const filled = this.closer.run(gaps.getImageData(0, 0, w, h).data, w, h, GAP_RADIUS * ((span * w) / width));
    gaps.putImageData(new ImageData(new Uint8ClampedArray(filled), w, h), 0, 0);
    layer.save();
    layer.globalCompositeOperation = "destination-over";
    layer.imageSmoothingQuality = "high";
    layer.drawImage(this.gaps, 0, 0, width, height);
    layer.restore();
  }

  /**
   * Cloth wraps round the body, so it turns away from the camera towards its edges and catches less
   * light there: the garment darkens softly inside its outline. Done at 1/8 size, where scaling the
   * outline down and up again blurs it.
   */
  private roundEdges(layer: CanvasRenderingContext2D, width: number, height: number) {
    const w = Math.max(1, Math.round(width / 8));
    const h = Math.max(1, Math.round(height / 8));
    for (const canvas of [this.edge, this.edgeShade]) {
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
    }
    const edge = this.edge.getContext("2d");
    const shade = this.edgeShade.getContext("2d");
    if (!edge || !shade) return;
    edge.clearRect(0, 0, w, h);
    edge.filter = `blur(${Math.max(1, w * 0.006)}px)`;
    edge.drawImage(this.layer, 0, 0, w, h);
    edge.filter = "none";
    // Dark where the (blurred) garment fades out: that's its edges, seen from inside.
    shade.globalCompositeOperation = "source-over";
    shade.fillStyle = "#000";
    shade.fillRect(0, 0, w, h);
    shade.globalCompositeOperation = "destination-out";
    shade.drawImage(this.edge, 0, 0);
    shade.globalCompositeOperation = "source-over";
    layer.save();
    layer.globalCompositeOperation = "source-atop";
    layer.globalAlpha = EDGE_SHADE;
    layer.imageSmoothingQuality = "high";
    layer.drawImage(this.edgeShade, 0, 0, width, height);
    layer.restore();
  }
}

/**
 * Gaps up to about twice this share of the shoulder width are sealed (about 7%: a sliver beside a sleeve,
 * never the space between an arm and the body).
 */
const GAP_RADIUS = 0.035;
/** The garment layer is sealed at a size where the shoulders are about this many pixels apart. */
const GAP_SPAN = 80;
const GAP_MAX_WIDTH = 480;

/** How dark a garment's edges get (0–1) where it turns away from the camera. */
const EDGE_SHADE = 0.45;
