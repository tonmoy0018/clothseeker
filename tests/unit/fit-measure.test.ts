import { describe, expect, it } from "vitest";

import { BODY_LEVELS } from "@/lib/fit/fit";
import { girthsFromPhoto, measurePhoto, type PersonAt } from "@/lib/fit/measure";
import { KEYPOINT_NAMES, type Keypoint, type Pose } from "@/lib/vision/movenet";

// Body measurements from a try-on photo: a drawn person (body points + outline) of known widths, 160 cm
// tall, standing in a 600×1000 photo with their head at y=50 and the floor at y=950.

const W = 600;
const H = 1000;
const CX = 300;
const FLOOR = 950;
const BODY = 900;
const PX_PER_CM = BODY / 160;
const at = (level: number) => FLOOR - level * BODY;

const SHOULDER_Y = at(BODY_LEVELS.shoulder);
const HIP_Y = at(BODY_LEVELS.hip);
const TORSO = HIP_Y - SHOULDER_Y;

type Body = { bust: number; waist: number; hip: number; shoulderHalf?: number };
const TYPICAL_WOMAN: Body = { bust: 29, waist: 26, hip: 35 };

function point(x: number, y: number, score = 0.9): Keypoint {
  return { x, y, score };
}

function pose(overrides: Partial<Pose> = {}, shoulderHalf = 90): Pose {
  const base = Object.fromEntries(KEYPOINT_NAMES.map((name) => [name, point(0, 0, 0)])) as Record<(typeof KEYPOINT_NAMES)[number], Keypoint>;
  return {
    ...base,
    nose: point(CX, at(0.93)),
    leftShoulder: point(CX + shoulderHalf, SHOULDER_Y),
    rightShoulder: point(CX - shoulderHalf, SHOULDER_Y),
    leftElbow: point(CX + 140, 380),
    rightElbow: point(CX - 140, 380),
    leftWrist: point(CX + 150, 520),
    rightWrist: point(CX - 150, 520),
    leftHip: point(CX + 45, HIP_Y),
    rightHip: point(CX - 45, HIP_Y),
    leftKnee: point(CX + 40, at(BODY_LEVELS.knee)),
    rightKnee: point(CX - 40, at(BODY_LEVELS.knee)),
    leftAnkle: point(CX + 35, at(BODY_LEVELS.ankle)),
    rightAnkle: point(CX - 35, at(BODY_LEVELS.ankle)),
    ...overrides,
  };
}

function segmentDistance(x: number, y: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/** The person's outline: head, neck, a torso with these widths (cm), legs, and arms hanging clear of it. */
function outline(body: Body, shoulderHalf = 90): PersonAt {
  const half = (cm: number) => (cm * PX_PER_CM) / 2;
  const rows: [number, number][] = [
    [SHOULDER_Y, shoulderHalf],
    [SHOULDER_Y + 0.32 * TORSO, half(body.bust)],
    [SHOULDER_Y + 0.7 * TORSO, half(body.waist)],
    [SHOULDER_Y + 1.1 * TORSO, half(body.hip)],
    [FLOOR, 45],
  ];
  const torsoHalf = (y: number) => {
    for (let i = 1; i < rows.length; i += 1) {
      const [y0, h0] = rows[i - 1] ?? [0, 0];
      const [y1, h1] = rows[i] ?? [0, 0];
      if (y <= y1) return h0 + ((h1 - h0) * (y - y0)) / (y1 - y0);
    }
    return 0;
  };
  const arms: [number, number, number, number][] = [];
  for (const side of [1, -1]) {
    arms.push([CX + side * shoulderHalf, SHOULDER_Y, CX + side * 140, 380], [CX + side * 140, 380, CX + side * 150, 560]);
  }
  return (x, y) => {
    if (y < 50 || y > FLOOR) return 0;
    if (y < 175) return Math.abs(x - CX) <= 45 ? 1 : 0;
    if (y < SHOULDER_Y) return Math.abs(x - CX) <= 25 ? 1 : 0;
    if (Math.abs(x - CX) <= torsoHalf(y)) return 1;
    return arms.some(([ax, ay, bx, by]) => segmentDistance(x, y, ax, ay, bx, by) <= 20) ? 1 : 0;
  };
}

function girths(body: Body, poseOverrides: Partial<Pose> = {}, heightCm = 160, photoHeight = H) {
  const result = measurePhoto("women", pose(poseOverrides), outline(body), W, photoHeight);
  if (!result.ok) throw new Error(`not measured: ${result.problem}`);
  return { result, girths: girthsFromPhoto("women", result.breadths, heightCm) };
}

describe("measuring the body from a photo", () => {
  it("finds a typical body's girths from its front widths and height, ignoring the arms beside it", () => {
    const { result, girths: g } = girths(TYPICAL_WOMAN);
    expect(result.fullLength).toBe(true);
    expect(g.map((x) => x.estimated)).toEqual([false, false, false]);
    const [bust, waist, hip] = g.map((x) => x.cm);
    expect(bust).toBeCloseTo(89, -0.5);
    expect(waist).toBeCloseTo(71, -0.5);
    expect(hip).toBeCloseTo(95, -0.5);
  });

  it("grows with a wider body, and with height for the same photo", () => {
    const wide = girths({ bust: 33, waist: 30, hip: 39 }).girths.map((x) => x.cm);
    const typical = girths(TYPICAL_WOMAN).girths.map((x) => x.cm);
    wide.forEach((cm, i) => expect(cm).toBeGreaterThan((typical[i] ?? 0) + 8));
    const taller = girths(TYPICAL_WOMAN, {}, 176).girths.map((x) => x.cm);
    expect(taller[0]).toBeCloseTo((typical[0] ?? 0) * 1.1, 0);
  });

  it("measures from the joints when the feet aren't in the photo", () => {
    const { result, girths: g } = girths(TYPICAL_WOMAN, { leftAnkle: point(0, 0, 0), rightAnkle: point(0, 0, 0) });
    expect(result.fullLength).toBe(false);
    expect(g[0]?.cm).toBeCloseTo(89, -0.5);
  });

  it("guesses a waist hidden by a loose top from the bust and hips", () => {
    const { girths: g } = girths({ bust: 29, waist: 30, hip: 35 });
    expect(g[1]?.estimated).toBe(true);
    expect(g[1]?.cm).toBeCloseTo(71, -0.5);
    expect(g[0]?.estimated).toBe(false);
  });

  it("guesses a man's neck from his chest", () => {
    const result = measurePhoto("men", pose(), outline({ bust: 32, waist: 29, hip: 35 }), W, H);
    if (!result.ok) throw new Error(result.problem);
    const [chest, waist, neck] = girthsFromPhoto("men", result.breadths, 172);
    expect(chest?.estimated).toBe(false);
    expect(waist?.estimated).toBe(false);
    expect(neck?.estimated).toBe(true);
    expect(neck?.cm).toBeCloseTo((39.5 * (chest?.cm ?? 0)) / 97, 0);
  });

  it("says why when it can't measure", () => {
    const problem = (p: Partial<Pose>, body = TYPICAL_WOMAN, photoHeight = H) => {
      const result = measurePhoto("women", pose(p), outline(body), W, photoHeight);
      return result.ok ? "measured" : result.problem;
    };
    expect(problem({ leftShoulder: point(0, 0, 0) })).toBe("no_body");
    expect(problem({ leftHip: point(0, 0, 0) })).toBe("no_hips");
    // A waist-up photo: cut off just below the hip joints.
    expect(problem({}, TYPICAL_WOMAN, Math.round(HIP_Y + 10))).toBe("no_hips");
    // Turned sideways: the shoulders overlap.
    expect(problem({ leftShoulder: point(CX + 20, SHOULDER_Y), rightShoulder: point(CX - 20, SHOULDER_Y) })).toBe("not_facing");
    // An outline no body has (the person model lost most of them).
    expect(problem({}, { bust: 13, waist: 11, hip: 15 })).toBe("unsure");
  });
});
