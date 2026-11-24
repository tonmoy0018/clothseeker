import { KEYPOINT_NAMES, type KeypointName } from "../models/movenet";

// One Euro filter (Casiez et al., 2012): smooths jittery keypoints while staying responsive. Slow
// movement is smoothed strongly; fast movement passes through with little lag. Pure and time-based.

const alpha = (cutoff: number, dt: number) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

export class OneEuro {
  private value: number | null = null;
  private derivative = 0;
  private lastTime = 0;

  /** `minCutoff` (Hz): smoothing when still; `beta`: how fast it follows quick movement. */
  constructor(
    private readonly minCutoff = 1.2,
    private readonly beta = 0.02,
    private readonly derivativeCutoff = 1,
  ) {}

  /** The smoothed value at `timeMs`. `unit`: speeds are measured in it (`beta` per unit a second). */
  next(raw: number, timeMs: number, unit = 1): number {
    if (this.value === null) {
      this.value = raw;
      this.lastTime = timeMs;
      return raw;
    }
    const dt = Math.max(1e-3, (timeMs - this.lastTime) / 1000);
    this.lastTime = timeMs;
    const rawDerivative = (raw - this.value) / dt;
    this.derivative += alpha(this.derivativeCutoff, dt) * (rawDerivative - this.derivative);
    const cutoff = this.minCutoff + (this.beta * Math.abs(this.derivative)) / unit;
    this.value += alpha(cutoff, dt) * (raw - this.value);
    return this.value;
  }

  reset(): void {
    this.value = null;
    this.derivative = 0;
  }
}

type Scored = { x: number; y: number; score: number };

/**
 * `minCutoff`/`beta` as for OneEuro. With `scale` (the pose's own size, e.g. its shoulder width; null
 * when unknown) movement is measured in that unit rather than pixels, so a person far from the camera,
 * whose joints jitter fewer pixels, is smoothed just like one close to it. (Only the speed is: dividing
 * the points themselves would move them all whenever the size estimate changed.)
 */
export type SmoothingOptions<K extends string> = { minCutoff?: number; beta?: number; scale?: (points: Record<K, Scored>) => number | null };

/** Smooths every keypoint of a pose (x and y separately). Low-confidence points reset their filters. */
export class PoseSmoother<K extends string> {
  private readonly filters = new Map<K, [OneEuro, OneEuro]>();
  /** The pose's size changes slowly (a step towards the camera), never with one frame's jitter. */
  private readonly size = new OneEuro(0.3, 0);
  private lastSize: number | null = null;

  constructor(
    private readonly names: readonly K[],
    private readonly minScore = 0.2,
    private readonly options: SmoothingOptions<K> = {},
  ) {}

  next<P extends Scored>(points: Record<K, P>, timeMs: number): Record<K, P> {
    const measured = this.options.scale?.(points) ?? null;
    if (measured !== null && measured > 1) this.lastSize = this.size.next(measured, timeMs);
    const unit = this.options.scale ? (this.lastSize ?? 1) : 1;
    const out = { ...points };
    for (const name of this.names) {
      const point = points[name];
      let pair = this.filters.get(name);
      if (!pair) {
        pair = [new OneEuro(this.options.minCutoff, this.options.beta), new OneEuro(this.options.minCutoff, this.options.beta)];
        this.filters.set(name, pair);
      }
      if (point.score < this.minScore) {
        pair[0].reset();
        pair[1].reset();
        continue;
      }
      out[name] = { ...point, x: pair[0].next(point.x, timeMs, unit), y: pair[1].next(point.y, timeMs, unit) };
    }
    return out;
  }
}

/** The shoulder width, when both shoulders are seen. */
function shoulderWidth(pose: Record<"leftShoulder" | "rightShoulder", Scored>): number | null {
  const { leftShoulder: l, rightShoulder: r } = pose;
  return l.score >= 0.3 && r.score >= 0.3 ? Math.hypot(l.x - r.x, l.y - r.y) : null;
}

/**
 * The live mirror's body smoothing, in shoulder widths: still, it lets through less than 0.4 Hz; moving
 * a shoulder width a second, about 8 Hz. Tuned with scripts/mirror-steadiness.ts (2026-11-24): on a still
 * person it halved how far the garment moves from frame to frame, and it follows a step sooner.
 */
export function bodySmoother(): PoseSmoother<KeypointName> {
  return new PoseSmoother(KEYPOINT_NAMES, 0.2, { minCutoff: 0.4, beta: 8, scale: shoulderWidth });
}
