import type { Audience } from "@/lib/catalog/garment-types";
import type { Keypoint, Pose } from "@/lib/vision/models/movenet";

import { BODY_LEVELS, type BodyGirth } from "./fit";

// Body measurements from the customer's own try-on photo (decided 2026-11-02: height is the only thing
// they type). The on-device body points and person outline give how wide they are at the bust, waist
// and hips (women's) or chest and waist (men's) as a share of their height; their height turns that
// into centimetres.
// Pure, so the browser (the fit report) and tests agree.
//
// What a single front photo can't see is depth: a body's girth is taken as its front width times the
// ratio of a typical body (TYPICAL). Loose clothes make the outline wider than the body, and arms
// touching the sides are cut off at the arm's inner edge. The typical widths were checked against our
// AI-generated test people (tests/fixtures/tryon-*.jpg), not tape-measured people.

/** How likely a photo pixel (x, y) belongs to the person, 0–1. */
export type PersonAt = (x: number, y: number) => number;

export type MeasureProblem =
  /** No person, or no shoulders. */
  | "no_body"
  /** Shoulders found, hips out of the picture. */
  | "no_hips"
  /** Turned sideways or leaning: the outline isn't their front width. */
  | "not_facing"
  /** The outline gave numbers no body has (arms across the body, very loose clothes, a cut-off photo…). */
  | "unsure";

export type PhotoMeasure =
  /**
   * `breadths`: front widths as shares of body height, in the order of the size chart's columns; null
   * where the photo can't show it (a men's neck; a waist under a loose top).
   */
  | { ok: true; breadths: (number | null)[]; fullLength: boolean }
  | { ok: false; problem: MeasureProblem };

const SEEN = 0.3;
const PERSON = 0.5;
/**
 * A waist as wide as this share of the bust (chest) in the outline is a loose top hanging straight down,
 * not the body (a typical body's is 0.90 for women, 0.94 for men).
 */
const HIDDEN_WAIST: Record<Audience, number> = { women: 0.97, men: 1.03 };

/**
 * A typical body in the middle of size M (160 cm women's, 172 cm men's): its girths (cm) and its front
 * widths at the same places (cm). Girth ÷ width is the depth this method has to assume.
 */
const TYPICAL: Record<Audience, { heightCm: number; girthsCm: readonly number[]; breadthsCm: readonly number[] }> = {
  women: { heightCm: 160, girthsCm: [89, 71, 95], breadthsCm: [29, 26, 35] },
  men: { heightCm: 172, girthsCm: [97, 83, 39.5], breadthsCm: [32, 30, 12] },
};

type P = { x: number; y: number };
const seen = (k: Keypoint) => k.score >= SEEN;
const mid = (a: P, b: P): P => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function distanceToSegment(p: P, a: P, b: P): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/**
 * The person's height in photo pixels: from the top of the head to the ankles when the whole body is in
 * the picture, else from the joints that are (shoulder → hip → knee → ankle, at standard proportions).
 */
function bodyHeightPx(pose: Pose, person: PersonAt, height: number): { px: number; fullLength: boolean } {
  const shoulders = mid(pose.leftShoulder, pose.rightShoulder);
  const hips = mid(pose.leftHip, pose.rightHip);
  const kneesSeen = seen(pose.leftKnee) && seen(pose.rightKnee);
  const anklesSeen = kneesSeen && seen(pose.leftAnkle) && seen(pose.rightAnkle);
  const ankles = mid(pose.leftAnkle, pose.rightAnkle);

  if (anklesSeen && seen(pose.nose) && ankles.y < height - 1) {
    // The top of the head: up from the nose until the outline ends (not at the photo's edge).
    let top = Math.round(pose.nose.y);
    while (top > 0 && person(pose.nose.x, top - 1) >= PERSON) top -= 1;
    if (top > 0) return { px: (ankles.y - top) / (1 - BODY_LEVELS.ankle), fullLength: true };
  }
  let px = hips.y - shoulders.y;
  let share = BODY_LEVELS.shoulder - BODY_LEVELS.hip;
  if (kneesSeen) {
    const knees = mid(pose.leftKnee, pose.rightKnee);
    px = knees.y - shoulders.y;
    share = BODY_LEVELS.shoulder - BODY_LEVELS.knee;
    if (anklesSeen) {
      px = ankles.y - shoulders.y;
      share = BODY_LEVELS.shoulder - BODY_LEVELS.ankle;
    }
  }
  return { px: px / share, fullLength: false };
}

/**
 * Front widths of the body at the bust, waist and hips (women's) or chest, waist and neck (men's), as
 * shares of body height; a problem when the photo doesn't show them well enough.
 */
export function measurePhoto(audience: Audience, pose: Pose, person: PersonAt, width: number, height: number): PhotoMeasure {
  const { leftShoulder: ls, rightShoulder: rs, leftHip: lh, rightHip: rh } = pose;
  if (!seen(ls) || !seen(rs)) return { ok: false, problem: "no_body" };
  if (!seen(lh) || !seen(rh) || lh.y >= height || rh.y >= height) return { ok: false, problem: "no_hips" };
  const shoulders = mid(ls, rs);
  const hips = mid(lh, rh);
  const torso = hips.y - shoulders.y;
  const span = ls.x - rs.x;
  // Facing the camera and upright: the shoulders are wide (and in the right order), the hips below them.
  if (torso <= 0 || span < 0.55 * torso || Math.abs(hips.x - shoulders.x) > 0.35 * torso) return { ok: false, problem: "not_facing" };

  const { px: bodyPx, fullLength } = bodyHeightPx(pose, person, height);

  // Arms (with the hands) where they hang beside the body: the outline is cut at their inner edge.
  const armHalf = span * 0.11;
  const arms: [P, P][] = [];
  for (const [shoulder, elbow, wrist] of [
    [ls, pose.leftElbow, pose.leftWrist],
    [rs, pose.rightElbow, pose.rightWrist],
  ] as const) {
    if (!seen(elbow)) continue;
    arms.push([shoulder, elbow]);
    if (!seen(wrist)) continue;
    const length = Math.max(1e-6, Math.hypot(wrist.x - elbow.x, wrist.y - elbow.y));
    const hand = { x: wrist.x + ((wrist.x - elbow.x) / length) * span * 0.3, y: wrist.y + ((wrist.y - elbow.y) / length) * span * 0.3 };
    arms.push([elbow, hand]);
  }
  const onArm = (p: P) => arms.some(([a, b]) => distanceToSegment(p, a, b) <= armHalf);

  /** The body's width (px) at row y, or null when it runs off the photo. */
  const breadthAt = (y: number): number | null => {
    if (y < 0 || y >= height) return null;
    const t = (y - shoulders.y) / torso;
    const centre = shoulders.x + (hips.x - shoulders.x) * t;
    let total = 0;
    for (const step of [-1, 1]) {
      let x = centre;
      while (person(x + step, y) >= PERSON && !onArm({ x: x + step, y })) {
        x += step;
        if (x <= 0 || x >= width - 1) return null;
      }
      total += Math.abs(x - centre);
    }
    return total;
  };
  /** Widths over a band of the torso (0 = shoulders, 1 = hips), every 2% of its length. */
  const band = (from: number, to: number): number[] => {
    const out: number[] = [];
    for (let t = from; t <= to + 1e-9; t += 0.02) {
      const b = breadthAt(Math.round(shoulders.y + t * torso));
      if (b !== null && b > 0) out.push(b);
    }
    return out;
  };

  const chest = band(0.25, 0.4);
  if (chest.length < 4) return { ok: false, problem: "unsure" };
  const chestPx = median(chest);
  let breadthsPx: (number | null)[];
  if (audience === "women") {
    // The waist is the narrowest place above the hips, the hips the widest just below the hip joints.
    const waist = band(0.5, 0.85);
    const hip = band(0.95, 1.25);
    // The hips are widest a little below the hip joints: the photo must reach that far.
    if (waist.length < 6 || hip.length < 12) return { ok: false, problem: "no_hips" };
    const waistPx = Math.min(...waist);
    // A top hanging straight down from the bust hides the waist: guessed from the bust and hips instead.
    breadthsPx = [chestPx, waistPx >= HIDDEN_WAIST.women * chestPx ? null : waistPx, Math.max(...hip)];
  } else {
    const waist = band(0.6, 0.85);
    if (waist.length < 6) return { ok: false, problem: "no_hips" };
    // The neck hides behind the chin and collar: guessed from the chest. So does a waist under a loose top.
    const waistPx = Math.min(...waist);
    breadthsPx = [chestPx, waistPx >= HIDDEN_WAIST.men * chestPx ? null : waistPx, null];
  }

  const breadths = breadthsPx.map((b) => (b === null ? null : b / bodyPx));
  // Nothing a body could be (arms across it, a coat, a cut-off photo): better no advice than wrong advice.
  const typical = TYPICAL[audience];
  const plausible = breadths.every((share, i) => {
    if (share === null) return true;
    const ratio = share / ((typical.breadthsCm[i] ?? 1) / typical.heightCm);
    return ratio > 0.65 && ratio < 1.8;
  });
  return plausible ? { ok: true, breadths, fullLength } : { ok: false, problem: "unsure" };
}

/** The waist's column in both size charts. */
const WAIST = 1;

/**
 * Girths (cm, the size chart's columns) of someone `heightCm` tall with these front widths. Ones the
 * photo doesn't show are `estimated` in a typical body's proportions, from the bust (chest) and hips:
 * the body's frame, which clothes and a belly change least.
 */
export function girthsFromPhoto(audience: Audience, breadths: readonly (number | null)[], heightCm: number): BodyGirth[] {
  const typical = TYPICAL[audience];
  const measured = breadths.map((share, i) => (share === null ? null : share * heightCm * ((typical.girthsCm[i] ?? 0) / (typical.breadthsCm[i] ?? 1))));
  const ratios = measured.flatMap((cm, i) => (cm === null || i === WAIST ? [] : [cm / (typical.girthsCm[i] ?? 1)]));
  const scale = ratios.length > 0 ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 1;
  const round = (cm: number) => Math.round(cm * 10) / 10;
  return measured.map((cm, i) => (cm === null ? { cm: round((typical.girthsCm[i] ?? 0) * scale), estimated: true } : { cm: round(cm), estimated: false }));
}

/** Customer-facing reasons a photo couldn't be measured. */
export const MEASURE_PROBLEM_TEXT: Record<MeasureProblem, string> = {
  no_body: "We couldn't find you in this photo.",
  no_hips: "We need to see you down to your hips.",
  not_facing: "Face the camera, standing straight.",
  unsure: "We couldn't measure you reliably from this photo (arms across the body or very loose clothes can do this).",
};
