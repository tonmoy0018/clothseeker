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

  /** The smoothed value at `timeMs`. */
  next(raw: number, timeMs: number): number {
    if (this.value === null) {
      this.value = raw;
      this.lastTime = timeMs;
      return raw;
    }
    const dt = Math.max(1e-3, (timeMs - this.lastTime) / 1000);
    this.lastTime = timeMs;
    const rawDerivative = (raw - this.value) / dt;
    this.derivative += alpha(this.derivativeCutoff, dt) * (rawDerivative - this.derivative);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.derivative);
    this.value += alpha(cutoff, dt) * (raw - this.value);
    return this.value;
  }

  reset(): void {
    this.value = null;
    this.derivative = 0;
  }
}

/** Smooths every keypoint of a pose (x and y separately). Low-confidence points reset their filters. */
export class PoseSmoother<K extends string> {
  private readonly filters = new Map<K, [OneEuro, OneEuro]>();

  constructor(
    private readonly names: readonly K[],
    private readonly minScore = 0.2,
  ) {}

  next<P extends { x: number; y: number; score: number }>(points: Record<K, P>, timeMs: number): Record<K, P> {
    const out = { ...points };
    for (const name of this.names) {
      const point = points[name];
      let pair = this.filters.get(name);
      if (!pair) {
        pair = [new OneEuro(), new OneEuro()];
        this.filters.set(name, pair);
      }
      if (point.score < this.minScore) {
        pair[0].reset();
        pair[1].reset();
        continue;
      }
      out[name] = { ...point, x: pair[0].next(point.x, timeMs), y: pair[1].next(point.y, timeMs) };
    }
    return out;
  }
}
