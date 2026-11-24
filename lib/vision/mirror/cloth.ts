import type { BodyWidths, Point } from "./mirror";

// Cloth movement for the live mirror, frame by frame. Pure and time-based (milliseconds), so it is
// unit-tested; the browser feeds it each frame's pose.

/** How fast a skirt swings back (Hz) and how quickly the swing dies down (damping ratio). */
export const SWAY_FREQUENCY = 1.3;
export const SWAY_DAMPING = 0.5;
/** The hem never trails further than this share of the shoulder width. */
export const MAX_SWAY = 0.45;

/**
 * A skirt's hem as a weight on a spring hanging from the hips: when the person moves, the hem lags
 * behind, then swings past and settles, as cloth does. `next` returns how far the hem is from where it
 * would hang at rest (camera pixels).
 */
export class ClothSway {
  private hem: Point | null = null;
  private velocity: Point = { x: 0, y: 0 };
  private lastTime = 0;

  constructor(
    private readonly frequency = SWAY_FREQUENCY,
    private readonly damping = SWAY_DAMPING,
  ) {}

  next(anchor: Point, span: number, timeMs: number): Point {
    if (!this.hem) {
      this.hem = { ...anchor };
      this.lastTime = timeMs;
      return { x: 0, y: 0 };
    }
    const omega = 2 * Math.PI * this.frequency;
    // Small steps keep the spring stable however slow the frames are; a long pause starts afresh.
    let remaining = Math.min(0.5, Math.max(0, (timeMs - this.lastTime) / 1000));
    this.lastTime = timeMs;
    while (remaining > 1e-6) {
      const dt = Math.min(1 / 120, remaining);
      remaining -= dt;
      for (const k of ["x", "y"] as const) {
        const accel = omega * omega * (anchor[k] - this.hem[k]) - 2 * this.damping * omega * this.velocity[k];
        this.velocity[k] += accel * dt;
        this.hem[k] += this.velocity[k] * dt;
      }
    }
    let offset = { x: this.hem.x - anchor.x, y: this.hem.y - anchor.y };
    // Cloth only trails so far, and barely lifts.
    offset.y = Math.min(offset.y, span * 0.08);
    const size = Math.hypot(offset.x, offset.y);
    const max = span * MAX_SWAY;
    if (size > max) {
      offset = { x: (offset.x * max) / size, y: (offset.y * max) / size };
      this.hem = { x: anchor.x + offset.x, y: anchor.y + offset.y };
    }
    return offset;
  }

  reset(): void {
    this.hem = null;
    this.velocity = { x: 0, y: 0 };
  }
}

/**
 * Smooths the garment's fitted widths over frames: the person mask is coarse and updates every other
 * frame, and its edges flicker; a garment shouldn't. `strength` is the share of the new value taken.
 */
export class WidthSmoother {
  private last: BodyWidths | null = null;

  constructor(private readonly strength = 0.2) {}

  next(widths: BodyWidths): BodyWidths {
    const last = this.last;
    const same = last && last.rows.length === widths.rows.length && last.rows.every((r, i) => Math.abs(r - (widths.rows[i] ?? r)) < 1e-6);
    const blend = (side: "left" | "right") => widths[side].map((v, i) => (same && last ? (last[side][i] ?? v) + (v - (last[side][i] ?? v)) * this.strength : v));
    this.last = { rows: widths.rows, left: blend("left"), right: blend("right") };
    return this.last;
  }

  reset(): void {
    this.last = null;
  }
}
