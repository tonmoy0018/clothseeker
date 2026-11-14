// Seals thin gaps between the garment's pieces in the live mirror (the body and each sleeve are fitted on
// their own, so where the body narrows to the person's outline a sliver can open beside a sleeve, and the
// person's painted-over clothes show through it). Works on a small copy of the garment layer: the
// garment's coverage is closed (grown, then shrunk by the same amount), and every pixel of the closed
// shape gets the average colour of the garment around it. Drawn under the garment, only the gaps show.
// Gaps wider than about twice the radius (a real space between an arm and the body) stay open. Pure.

/** Covered: at least half opaque. */
const COVERED = 128;

/** Reusable buffers, so a frame allocates nothing once the size settles. */
export class GapCloser {
  private size = 0;
  private covered = new Uint8Array(0);
  private passA = new Uint8Array(0);
  private passB = new Uint8Array(0);
  private sums = new Float32Array(0);
  private rowSums = new Float32Array(0);
  private out = new Uint8ClampedArray(0);

  /**
   * `rgba`: the garment layer, width×height, straight (not premultiplied) colours as getImageData gives
   * them. Returns an RGBA picture (reused between calls) that is opaque on the closed shape, coloured
   * like the garment nearby, and transparent elsewhere.
   */
  run(rgba: ArrayLike<number>, width: number, height: number, radius: number): Uint8ClampedArray {
    const n = width * height;
    if (this.size !== n) {
      this.size = n;
      this.covered = new Uint8Array(n);
      this.passA = new Uint8Array(n);
      this.passB = new Uint8Array(n);
      this.sums = new Float32Array(n * 4);
      this.rowSums = new Float32Array(n * 4);
      this.out = new Uint8ClampedArray(n * 4);
    }
    const r = Math.max(0, Math.round(radius));
    for (let p = 0; p < n; p += 1) this.covered[p] = (rgba[p * 4 + 3] ?? 0) >= COVERED ? 1 : 0;

    // Closing: grow (the largest value in the window), then shrink (the smallest), each row then column.
    windowPass(this.covered, this.passA, width, height, r, true, 1);
    windowPass(this.passA, this.passB, width, height, r, false, 1);
    windowPass(this.passB, this.passA, width, height, r, true, 0);
    windowPass(this.passA, this.passB, width, height, r, false, 0);
    const closed = this.passB;

    // The garment's colour around each pixel: alpha-weighted averages over a window a little wider than
    // the closing, so a gap's middle reaches fabric on both sides.
    this.averageColours(rgba, width, height, r + 1);
    this.out.fill(0);
    for (let p = 0; p < n; p += 1) {
      if (!closed[p]) continue;
      const weight = this.sums[p * 4 + 3] ?? 0;
      if (weight <= 0) continue;
      for (let c = 0; c < 3; c += 1) this.out[p * 4 + c] = (this.sums[p * 4 + c] ?? 0) / weight;
      this.out[p * 4 + 3] = 255;
    }
    return this.out;
  }

  /** Box sums of alpha-weighted colour (and of alpha) over (2w+1)² windows, into `sums`. */
  private averageColours(rgba: ArrayLike<number>, width: number, height: number, w: number) {
    const rows = this.rowSums;
    for (let y = 0; y < height; y += 1) {
      const acc = [0, 0, 0, 0];
      const add = (x: number, sign: number) => {
        if (x < 0 || x >= width) return;
        const i = (y * width + x) * 4;
        const a = (rgba[i + 3] ?? 0) / 255;
        acc[0] = (acc[0] ?? 0) + sign * a * (rgba[i] ?? 0);
        acc[1] = (acc[1] ?? 0) + sign * a * (rgba[i + 1] ?? 0);
        acc[2] = (acc[2] ?? 0) + sign * a * (rgba[i + 2] ?? 0);
        acc[3] = (acc[3] ?? 0) + sign * a;
      };
      for (let x = -w; x < w; x += 1) add(x, 1);
      for (let x = 0; x < width; x += 1) {
        add(x + w, 1);
        const o = (y * width + x) * 4;
        for (let c = 0; c < 4; c += 1) rows[o + c] = acc[c] ?? 0;
        add(x - w, -1);
      }
    }
    for (let x = 0; x < width; x += 1) {
      const acc = [0, 0, 0, 0];
      const add = (y: number, sign: number) => {
        if (y < 0 || y >= height) return;
        const i = (y * width + x) * 4;
        for (let c = 0; c < 4; c += 1) acc[c] = (acc[c] ?? 0) + sign * (rows[i + c] ?? 0);
      };
      for (let y = -w; y < w; y += 1) add(y, 1);
      for (let y = 0; y < height; y += 1) {
        add(y + w, 1);
        const o = (y * width + x) * 4;
        for (let c = 0; c < 4; c += 1) this.sums[o + c] = acc[c] ?? 0;
        add(y - w, -1);
      }
    }
  }
}

/**
 * One direction of a grow (`edge` 1: any covered pixel in the window covers) or shrink (`edge` 0: any
 * uncovered one uncovers) with a window of 2r+1, along rows (`rows`) or columns. Outside the picture
 * counts as uncovered, so nothing is filled between the garment and the picture's edge (a garment that
 * touches the edge loses its fill there, which doesn't show: the fill is drawn under it).
 */
function windowPass(from: Uint8Array, to: Uint8Array, width: number, height: number, r: number, rows: boolean, edge: 0 | 1) {
  const lines = rows ? height : width;
  const length = rows ? width : height;
  const at = (line: number, i: number) => (rows ? line * width + i : i * width + line);
  for (let line = 0; line < lines; line += 1) {
    // How many pixels in the window have the deciding value (covered when growing, uncovered when shrinking).
    let count = 0;
    const decides = (i: number) => (i < 0 || i >= length ? 1 - edge : from[at(line, i)] === edge ? 1 : 0);
    for (let i = -r; i < r; i += 1) count += decides(i);
    for (let i = 0; i < length; i += 1) {
      count += decides(i + r);
      to[at(line, i)] = count > 0 ? edge : 1 - edge;
      count -= decides(i - r);
    }
  }
}
