import { triangleTransform, type Point, type Triangle } from "./mirror";
import { shadeFromFrame } from "./relight";
import { SELFIE_SIZE, type PersonMask } from "./segment";

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
   * by the person outline, so arms in front of the body show in front of the garment.
   */
  drawArms(context: CanvasRenderingContext2D, frame: CanvasImageSource, width: number, height: number, paths: readonly Point[][], thickness: number) {
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
    person.drawImage(this.maskSquare, -offsetX / scale, -offsetY / scale, SELFIE_SIZE / scale, SELFIE_SIZE / scale);
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
 * Puts the garment on the camera frame so it looks worn: its pieces are drawn into their own layer, lit
 * by the camera's light (relight.ts, soft-light blend), and laid on the frame with a soft contact
 * shadow.
 */
export class GarmentCompositor {
  private readonly layer = document.createElement("canvas");
  private readonly shade = document.createElement("canvas");
  private readonly small = document.createElement("canvas");

  /** `pieces`: each garment picture with its mesh. */
  draw(context: CanvasRenderingContext2D, frame: CanvasImageSource, width: number, height: number, pieces: readonly { image: CanvasImageSource; triangles: readonly Triangle[] }[]) {
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

    // Resting on the body: a soft shadow just below and around the garment.
    context.save();
    context.shadowColor = "rgba(0, 0, 0, 0.32)";
    context.shadowBlur = Math.max(4, width * 0.012);
    context.shadowOffsetY = Math.max(1, height * 0.004);
    context.drawImage(this.layer, 0, 0);
    context.restore();
  }
}
