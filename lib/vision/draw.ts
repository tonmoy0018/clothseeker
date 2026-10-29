import type { Pose } from "./movenet";
import { triangleTransform, type Triangle } from "./mirror";
import { SELFIE_SIZE, type PersonMask } from "./segment";

// Canvas drawing for the live mirror (browser only). The geometry comes from mirror.ts.

/** Draws a picture through a triangle mesh (each triangle an affine piece; seams overlap by half a pixel). */
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
      const x = p.x + ((p.x - cx) / len) * 0.6;
      const y = p.y + ((p.y - cy) / len) * 0.6;
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
   * Draws the person's forearms and hands from `frame` over what's on `context`, so they show in front
   * of the garment. Upper arms stay under it: the garment's sleeves don't move with the arms.
   */
  drawForearms(context: CanvasRenderingContext2D, frame: CanvasImageSource, width: number, height: number, pose: Pose) {
    if (!this.maskSet || !this.box) return;
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

    const span = Math.hypot(pose.leftShoulder.x - pose.rightShoulder.x, pose.leftShoulder.y - pose.rightShoulder.y);
    arms.clearRect(0, 0, width, height);
    arms.globalCompositeOperation = "source-over";
    arms.strokeStyle = "#fff";
    arms.lineCap = "round";
    arms.lineWidth = Math.max(8, span * 0.32);
    let any = false;
    for (const [elbow, wrist] of [
      [pose.leftElbow, pose.leftWrist],
      [pose.rightElbow, pose.rightWrist],
    ] as const) {
      if (elbow.score < 0.3 || wrist.score < 0.3) continue;
      // From just below the elbow to past the wrist, where the hand is.
      const start = { x: elbow.x + (wrist.x - elbow.x) * 0.15, y: elbow.y + (wrist.y - elbow.y) * 0.15 };
      const end = { x: wrist.x + (wrist.x - elbow.x) * 0.45, y: wrist.y + (wrist.y - elbow.y) * 0.45 };
      arms.beginPath();
      arms.moveTo(start.x, start.y);
      arms.lineTo(end.x, end.y);
      arms.stroke();
      any = true;
    }
    if (!any) return;
    arms.globalCompositeOperation = "source-in";
    arms.drawImage(this.person, 0, 0);
    context.drawImage(this.arms, 0, 0);
  }
}
