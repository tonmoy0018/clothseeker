import { describe, expect, it } from "vitest";

import type { Keypoint, Pose } from "@/lib/vision/movenet";
import {
  armChain,
  bodyAnchors,
  exposedArm,
  garmentFit,
  garmentMesh,
  garmentToBody,
  maskBounds,
  SEAM_PER_JOINTS,
  SHOULDER_LIFT,
  sleeveFits,
  sleeveMesh,
  triangleTransform,
  type GarmentFit,
  type SleeveFit,
} from "@/lib/vision/mirror";
import { featherAlpha, shadeFromFrame } from "@/lib/vision/relight";
import { splitGarment, type Mask } from "@/lib/garment-photo/segment";

// Live mirror fitting: where each point of a garment picture lands on a person in the camera frame.

const at = (x: number, y: number, score = 0.9): Keypoint => ({ x, y, score });

/** Standing straight, facing the camera: the person's left shoulder on the picture's right. */
function pose(overrides: Partial<Pose> = {}): Pose {
  return {
    nose: at(500, 150),
    leftEye: at(510, 140),
    rightEye: at(490, 140),
    leftEar: at(520, 145),
    rightEar: at(480, 145),
    leftShoulder: at(560, 250),
    rightShoulder: at(440, 250),
    leftElbow: at(570, 350),
    rightElbow: at(430, 350),
    leftWrist: at(575, 440),
    rightWrist: at(425, 440),
    leftHip: at(540, 450),
    rightHip: at(460, 450),
    leftKnee: at(540, 600),
    rightKnee: at(460, 600),
    leftAnkle: at(540, 750),
    rightAnkle: at(460, 750),
    ...overrides,
  };
}

const FIT: GarmentFit = { width: 400, height: 600, top: 20, bottom: 560, left: 50, right: 350, shoulderY: 20, waistY: 220, centreX: 200, shoulderWidth: 240 };

describe("live mirror fitting", () => {
  it("needs shoulders and hips, facing the camera", () => {
    expect(bodyAnchors(pose())).not.toBeNull();
    expect(bodyAnchors(pose({ leftHip: at(540, 450, 0.1) }))).toBeNull();
    // Turned away: the left shoulder is on the picture's left.
    expect(bodyAnchors(pose({ leftShoulder: at(440, 250), rightShoulder: at(560, 250) }))).toBeNull();
    expect(bodyAnchors(pose({ leftKnee: at(540, 600, 0.1) }))?.knees).toBeNull();
  });

  it("pins the garment's shoulders just above the shoulder joints, scaled to the shoulders", () => {
    const body = bodyAnchors(pose());
    if (!body) throw new Error("no body");
    const map = garmentToBody(FIT, body);
    const scale = (120 * SEAM_PER_JOINTS) / FIT.shoulderWidth;
    const centre = map(FIT.centreX, FIT.shoulderY);
    expect(centre.x).toBeCloseTo(500);
    expect(centre.y).toBeCloseTo(250 - 120 * SHOULDER_LIFT);
    // The garment's right edge (the wearer's left) lands on the picture's right.
    const edge = map(FIT.centreX + 100, FIT.shoulderY);
    expect(edge.x).toBeCloseTo(500 + 100 * scale);
    // The garment's waist sits at the body's waist (60% of the way to the hips).
    const lift = 120 * SHOULDER_LIFT;
    expect(map(FIT.centreX, FIT.waistY).y).toBeCloseTo(250 - lift + 0.6 * (200 + lift));
    // Below the waist it keeps hanging downwards.
    expect(map(FIT.centreX, 500).y).toBeGreaterThan(map(FIT.centreX, 300).y);
  });

  it("follows a leaning body, and narrows when the person turns", () => {
    const leaning = bodyAnchors(pose({ leftShoulder: at(590, 250), rightShoulder: at(470, 250) }));
    if (!leaning) throw new Error("no body");
    const top = garmentToBody(FIT, leaning)(FIT.centreX, FIT.shoulderY);
    expect(top.x).toBeGreaterThan(510);
    const turned = bodyAnchors(pose({ leftShoulder: at(530, 250), rightShoulder: at(470, 250) }));
    const straight = bodyAnchors(pose());
    if (!turned || !straight) throw new Error("no body");
    const width = (b: NonNullable<typeof turned>) => garmentToBody(FIT, b)(FIT.right, 300).x - garmentToBody(FIT, b)(FIT.left, 300).x;
    expect(width(turned)).toBeLessThan(width(straight) * 0.6);
  });

  it("covers the garment's box with mapped triangles whose transforms reproduce the mapping", () => {
    const body = bodyAnchors(pose());
    if (!body) throw new Error("no body");
    const mesh = garmentMesh(FIT, body, 4, 8);
    expect(mesh).toHaveLength(4 * 8 * 2);
    for (const triangle of mesh.slice(0, 6)) {
      const m = triangleTransform(triangle.src, triangle.dst);
      if (!m) throw new Error("degenerate");
      const [a, b, c, d, e, f] = m;
      for (let k = 0; k < 3; k += 1) {
        const s = triangle.src[k];
        const t = triangle.dst[k];
        if (!s || !t) throw new Error("missing corner");
        expect(a * s.x + c * s.y + e).toBeCloseTo(t.x, 6);
        expect(b * s.x + d * s.y + f).toBeCloseTo(t.y, 6);
      }
    }
    expect(triangleTransform([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }], [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }])).toBeNull();
  });

  it("reads a garment's fit from its outline", () => {
    // A simple dress shape: shoulders 40 px wide at row 10, narrowing to a waist, then a flared skirt.
    const width = 100;
    const height = 120;
    const mask: Mask = { data: new Uint8Array(width * height), width, height };
    for (let y = 10; y < 110; y += 1) {
      const half = y < 50 ? 20 - (y - 10) * 0.2 : 12 + (y - 50) * 0.4;
      for (let x = Math.round(50 - half); x < Math.round(50 + half); x += 1) mask.data[y * width + x] = 1;
    }
    expect(maskBounds(mask)).toEqual({ top: 10, bottom: 109, left: 14, right: 85 }); // widest at the hem
    const fit = garmentFit(splitGarment(mask));
    expect(fit.shoulderY).toBe(10);
    expect(Math.abs(fit.centreX - 50)).toBeLessThanOrEqual(1);
    expect(fit.waistY).toBeGreaterThan(fit.shoulderY);
  });

  it("finds real sleeves, not straps", () => {
    const width = 400;
    const height = 600;
    const mask: Mask = { data: new Uint8Array(width * height), width, height };
    const fill = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) mask.data[y * width + x] = 1;
    };
    // Sleeves hanging down outside the shoulders (centre 200, shoulders 240 wide: 80–320).
    fill(300, 30, 340, 300);
    fill(60, 30, 100, 300);
    const found = sleeveFits(mask, FIT);
    expect(found.map((f) => f.side).sort()).toEqual(["left", "right"]);
    const left = found.find((f) => f.side === "left");
    expect(left?.end.y).toBeGreaterThan(200);
    // Thin straps over the shoulders, inside the trunk: not sleeves.
    const straps: Mask = { data: new Uint8Array(width * height), width, height };
    for (let y = 0; y < 40; y += 1) for (const x0 of [150, 240]) for (let x = x0; x < x0 + 10; x += 1) straps.data[y * width + x] = 1;
    expect(sleeveFits(straps, FIT)).toEqual([]);
  });

  it("bends a sleeve along the arm, joined to the torso, never past the wrist", () => {
    const sleeve: SleeveFit = { side: "left", root: { x: 320, y: 34 }, end: { x: 330, y: 400 }, halfWidth: 25, length: 366 };
    // Left arm held straight out to the side (the picture's right).
    const body = bodyAnchors(pose({ leftElbow: at(660, 250), leftWrist: at(760, 250) }));
    if (!body) throw new Error("no body");
    const mesh = sleeveMesh(FIT, sleeve, body);
    const torso = garmentToBody(FIT, body)(sleeve.root.x, sleeve.root.y);
    const rootCorner = mesh.find((t) => t.src.some((p) => Math.abs(p.x - sleeve.root.x) < 26 && Math.abs(p.y - sleeve.root.y) < 1));
    expect(rootCorner).toBeDefined();
    const ends = mesh.flatMap((t) => t.dst);
    // It runs out to the right with the arm, and stops near the wrist (the hand is 760 + a bit).
    expect(Math.max(...ends.map((p) => p.x))).toBeGreaterThan(700);
    expect(Math.max(...ends.map((p) => p.x))).toBeLessThan(790);
    // Its top reaches a little above the root (the shoulder cap, mapped like the body), no further.
    expect(Math.abs(Math.min(...ends.map((p) => p.y)) - torso.y)).toBeLessThan(80);
    expect(armChain(body, "left")).toHaveLength(4);
  });

  it("draws the arms the garment doesn't cover in front of it", () => {
    const body = bodyAnchors(pose());
    if (!body) throw new Error("no body");
    const shortSleeve: SleeveFit = { side: "right", root: { x: 80, y: 34 }, end: { x: 75, y: 120 }, halfWidth: 30, length: 86 };
    const longSleeve: SleeveFit = { ...shortSleeve, end: { x: 75, y: 900 }, length: 866 };
    const sleeveless = exposedArm(FIT, body, "right", null);
    const short = exposedArm(FIT, body, "right", shortSleeve);
    // Sleeveless: almost the whole arm; short sleeve: from above the elbow; long sleeve: just the hand.
    expect(sleeveless[0]?.y).toBeLessThan(short[0]?.y ?? 0);
    expect(short.at(-1)?.y).toBeGreaterThan(440);
    const long = exposedArm(FIT, body, "right", longSleeve);
    expect(long.length === 0 || (long[0]?.y ?? 0) >= 435).toBe(true);
  });
});

describe("relighting from the camera", () => {
  const frame = (width: number, height: number, paint: (x: number, y: number) => [number, number, number]) => {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) rgba.set([...paint(x, y), 255], (y * width + x) * 4);
    return rgba;
  };

  it("leaves the garment alone under even, neutral light", () => {
    const shade = shadeFromFrame(frame(60, 40, () => [120, 120, 120]), 60, 40);
    expect(Math.abs((shade[(20 * 60 + 30) * 4] ?? 0) - 128)).toBeLessThanOrEqual(2);
  });

  it("darkens folds, follows brighter light and takes on a warm cast", () => {
    // A dark crease down the middle of evenly lit clothes.
    const crease = shadeFromFrame(frame(60, 40, (x) => (x >= 29 && x <= 30 ? [60, 60, 60] : [140, 140, 140])), 60, 40);
    expect(crease[(20 * 60 + 30) * 4] ?? 255).toBeLessThan(110);
    // Light from the right: the right side comes out lighter than the left.
    const sided = shadeFromFrame(frame(60, 40, (x) => [60 + x * 2.5, 60 + x * 2.5, 60 + x * 2.5]), 60, 40);
    expect(sided[(20 * 60 + 55) * 4] ?? 0).toBeGreaterThan(sided[(20 * 60 + 4) * 4] ?? 0);
    // Warm light: red above blue.
    const warm = shadeFromFrame(frame(60, 40, () => [170, 130, 100]), 60, 40);
    expect(warm[(20 * 60 + 30) * 4] ?? 0).toBeGreaterThan(warm[(20 * 60 + 30) * 4 + 2] ?? 0);
  });

  it("softens a cut-out's edge without thinning its inside", () => {
    const alpha = new Uint8ClampedArray(10 * 10);
    for (let y = 0; y < 10; y += 1) for (let x = 0; x < 5; x += 1) alpha[y * 10 + x] = 255;
    featherAlpha(alpha, 10, 10, 1);
    expect(alpha[5 * 10 + 1]).toBe(255);
    expect(alpha[5 * 10 + 4]).toBeLessThan(255);
    expect(alpha[5 * 10 + 4]).toBeGreaterThan(100);
    expect(alpha[5 * 10 + 5]).toBeGreaterThan(0);
    expect(alpha[5 * 10 + 9]).toBe(0);
  });
});
