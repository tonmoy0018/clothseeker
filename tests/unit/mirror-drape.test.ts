import { describe, expect, it } from "vitest";

import { ClothSway, MAX_SWAY, WidthSmoother } from "@/lib/vision/mirror/cloth";
import type { Keypoint, Pose } from "@/lib/vision/models/movenet";
import { bodyAnchors, fitToOutline, garmentToBody, MAX_WIDEN, measureOutline, MIN_FIT, type BodyAnchors, type GarmentFit } from "@/lib/vision/mirror/mirror";
import { isSkin, skinModel, uncoverOwnClothes } from "@/lib/vision/mirror/uncover";

// Making the live mirror's garment move like worn cloth: fitted to the person's own outline (and so to
// their turns), skirts covering legs that step apart and swinging behind the hips, and the person's
// own clothes, where the garment doesn't cover them, turned into skin or backdrop.

const at = (x: number, y: number, score = 0.9): Keypoint => ({ x, y, score });
function pose(overrides: Partial<Pose> = {}): Pose {
  return {
    nose: at(500, 150),
    leftEye: at(510, 140),
    rightEye: at(490, 140),
    leftEar: at(520, 145),
    rightEar: at(480, 145),
    leftShoulder: at(560, 250),
    rightShoulder: at(440, 250),
    // Arms held out to the sides, clear of the body.
    leftElbow: at(660, 250),
    rightElbow: at(340, 250),
    leftWrist: at(760, 250),
    rightWrist: at(240, 250),
    leftHip: at(540, 450),
    rightHip: at(460, 450),
    leftKnee: at(540, 600),
    rightKnee: at(460, 600),
    leftAnkle: at(540, 750),
    rightAnkle: at(460, 750),
    ...overrides,
  };
}
function anchors(overrides: Partial<Pose> = {}): BodyAnchors {
  const body = bodyAnchors(pose(overrides));
  if (!body) throw new Error("no body");
  return body;
}

/** A dress: shoulders at row 20, waist at 220, hem at 560; its body 100 px either side of the centre. */
const FIT: GarmentFit = {
  width: 400,
  height: 600,
  top: 20,
  bottom: 560,
  left: 50,
  right: 350,
  shoulderY: 20,
  waistY: 220,
  centreX: 200,
  shoulderWidth: 240,
  rowHalfWidth: Array.from({ length: 600 }, (_, y) => (y >= 20 && y <= 560 ? 100 : 0)),
};
// The garment scale for the test pose: 120 px between the shoulder joints × 1.1 ÷ 240 = 0.55, so the
// garment's body is 55 camera px either side of the centre line.

/** A person whose torso reaches `left`/`right` px either side of x = 500, from the shoulders to the feet. */
const torso = (left: number, right: number) => (x: number, y: number) => (y >= 220 && y <= 780 && x <= 500 + left && x >= 500 - right ? 1 : 0);

describe("fitting the garment to the person's outline", () => {
  it("measures how far the body reaches on each side", () => {
    const outline = measureOutline(FIT, anchors(), torso(70, 50));
    const waistRow = outline.rows.findIndex((r) => r >= FIT.waistY);
    expect(outline.left[waistRow]).toBeGreaterThan(66);
    expect(outline.left[waistRow]).toBeLessThan(72);
    expect(outline.right[waistRow]).toBeGreaterThan(46);
    expect(outline.right[waistRow]).toBeLessThan(52);
  });

  it("stops at an arm hanging beside the body", () => {
    // The whole area is "person", but the left arm hangs 70 px out: the body ends where the arm begins.
    const hanging = anchors({ leftElbow: at(570, 350), leftWrist: at(575, 440) });
    const outline = measureOutline(FIT, hanging, torso(120, 120));
    const chest = outline.rows.findIndex((r) => r >= FIT.shoulderY + 100);
    expect(outline.left[chest]).toBeLessThan(65);
    expect(outline.right[chest]).toBeGreaterThan(100);
  });

  it("wraps the body: wider or narrower, but keeps its shoulders and never shrinks a skirt", () => {
    const body = anchors();
    // Wider than the garment on the person's left, slimmer on their right.
    const widths = fitToOutline(FIT, body, measureOutline(FIT, body, torso(70, 40)));
    const row = (gy: number) => widths.rows.findIndex((r) => r >= gy);
    const waist = row(FIT.waistY);
    expect(widths.left[waist]).toBeGreaterThan(1.25);
    expect(widths.left[waist]).toBeLessThanOrEqual(MAX_WIDEN);
    expect(widths.right[waist]).toBeLessThan(0.9);
    expect(widths.right[waist]).toBeGreaterThanOrEqual(MIN_FIT - 1e-9);
    expect(widths.left[0]).toBeCloseTo(1, 3);
    expect(widths.right[0]).toBeCloseTo(1, 3);
    expect(Math.min(...widths.right.slice(row(500)))).toBeGreaterThanOrEqual(1);

    const map = garmentToBody(FIT, body, { widths });
    const plain = garmentToBody(FIT, body);
    expect(map(FIT.centreX + 100, FIT.waistY).x - 500).toBeGreaterThan((plain(FIT.centreX + 100, FIT.waistY).x - 500) * 1.2);
    expect(map(FIT.centreX, FIT.waistY).x).toBeCloseTo(plain(FIT.centreX, FIT.waistY).x, 6);
  });

  it("narrows the far side when the person turns", () => {
    const body = anchors();
    const widths = fitToOutline(FIT, body, measureOutline(FIT, body, torso(30, 60)));
    const map = garmentToBody(FIT, body, { widths });
    const left = map(FIT.centreX + 100, 150).x - map(FIT.centreX, 150).x;
    const right = map(FIT.centreX, 150).x - map(FIT.centreX - 100, 150).x;
    expect(left).toBeLessThan(right * 0.75);
  });

  it("widens a skirt to cover legs stepping apart", () => {
    const body = anchors({ leftKnee: at(600, 600), rightKnee: at(440, 600) });
    // Legs: two columns at 470–490 and 590–615 below the hips, the torso above.
    const person = (x: number, y: number) => (y >= 220 && y < 460 ? (Math.abs(x - 500) <= 50 ? 1 : 0) : y >= 460 && y <= 780 && ((x >= 470 && x <= 490) || (x >= 590 && x <= 615 + (y - 460) * 0.1)) ? 1 : 0);
    const outline = measureOutline(FIT, body, person);
    const knee = outline.rows.findIndex((r) => r >= 500);
    expect(outline.left[knee]).toBeGreaterThan(90);
    const widths = fitToOutline(FIT, body, outline);
    expect(widths.left[knee]).toBeGreaterThan(1.4);
  });

  it("smooths the widths over frames", () => {
    const smoother = new WidthSmoother(0.5);
    const rows = [0, 1];
    smoother.next({ rows, left: [1, 1], right: [1, 1] });
    expect(smoother.next({ rows, left: [1.4, 1.4], right: [1, 1] }).left[0]).toBeCloseTo(1.2);
  });
});

describe("cloth moving with the person", () => {
  it("lets the hem trail behind, swing past and settle", () => {
    const sway = new ClothSway();
    const span = 120;
    expect(sway.next({ x: 500, y: 450 }, span, 0)).toEqual({ x: 0, y: 0 });
    // The person steps 40 px to the side: at first the hem stays behind.
    const first = sway.next({ x: 540, y: 450 }, span, 33);
    expect(first.x).toBeLessThan(-30);
    let overshoot = 0;
    let last = first;
    for (let t = 66; t <= 3000; t += 33) {
      last = sway.next({ x: 540, y: 450 }, span, t);
      overshoot = Math.max(overshoot, last.x);
    }
    expect(overshoot).toBeGreaterThan(2);
    expect(Math.abs(last.x)).toBeLessThan(1);
    // A sudden jump never drags the hem further than MAX_SWAY of the shoulders.
    expect(Math.hypot(...Object.values(sway.next({ x: 900, y: 450 }, span, 3033)))).toBeLessThanOrEqual(span * MAX_SWAY + 1e-6);
  });

  it("swings the hem, not the bodice", () => {
    const body = anchors();
    const still = garmentToBody(FIT, body);
    const swaying = garmentToBody(FIT, body, { sway: { x: -30, y: 0 } });
    expect(swaying(FIT.centreX, FIT.waistY).x).toBeCloseTo(still(FIT.centreX, FIT.waistY).x, 6);
    expect(swaying(FIT.centreX, FIT.bottom).x).toBeCloseTo(still(FIT.centreX, FIT.bottom).x - 30, 3);
  });

  it("hangs a skirt partly straight down when the body leans", () => {
    // Knees far to the side of the hips: the hem follows them only partly.
    const body = anchors({ leftKnee: at(640, 580), rightKnee: at(560, 580) });
    const map = garmentToBody(FIT, body);
    const hips = map(FIT.centreX, FIT.waistY);
    const hem = map(FIT.centreX, FIT.bottom);
    const legs = Math.atan2(600 - 500, 580 - 450);
    expect(Math.atan2(hem.x - hips.x, hem.y - hips.y)).toBeLessThan(legs * 0.8);
  });
});

describe("hiding the person's own clothes the garment doesn't cover", () => {
  // A 200×200 frame (camera scale 1): backdrop, a skin-coloured face, and a grey T-shirt over the
  // shoulders, body and upper arms (the arms hang straight down at x = 70 and 130).
  const SKIN: [number, number, number] = [205, 150, 120];
  const SHIRT: [number, number, number] = [128, 128, 132];
  const WALL: [number, number, number] = [220, 222, 230];
  const body: BodyAnchors = {
    leftShoulder: { x: 130, y: 70 },
    rightShoulder: { x: 70, y: 70 },
    leftHip: { x: 120, y: 160 },
    rightHip: { x: 80, y: 160 },
    knees: null,
    arms: { left: { elbow: { x: 132, y: 120 }, wrist: { x: 133, y: 165 } }, right: { elbow: { x: 68, y: 120 }, wrist: { x: 67, y: 165 } } },
    face: { nose: { x: 100, y: 35 }, leftEye: { x: 108, y: 28 }, rightEye: { x: 92, y: 28 } },
  };
  const shirt = (x: number, y: number) => (y >= 62 && y < 175 && Math.abs(x - 100) <= 42) || (y >= 62 && y < 100 && Math.abs(x - 100) <= 50);
  const face = (x: number, y: number) => Math.hypot(x - 100, y - 35) <= 22 || (y >= 50 && y < 62 && Math.abs(x - 100) <= 8);
  const width = 200;
  const height = 200;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const colour = face(x, y) ? SKIN : shirt(x, y) ? SHIRT : WALL;
      rgba.set([...colour, 255], (y * width + x) * 4);
    }
  }
  const person = (x: number, y: number) => (face(Math.floor(x), Math.floor(y)) || shirt(Math.floor(x), Math.floor(y)) ? 1 : 0);
  const pixel = (out: Uint8ClampedArray, x: number, y: number) => Array.from(out.slice((y * width + x) * 4, (y * width + x) * 4 + 4));

  it("reads the skin colour from the face", () => {
    const face = body.face;
    if (!face) throw new Error("no face");
    const skin = skinModel(rgba, width, height, 1, face);
    if (!skin) throw new Error("no skin");
    expect(skin.rgb).toEqual(SKIN);
    expect(isSkin(skin, ...SKIN)).toBe(true);
    expect(isSkin(skin, 160, 115, 90)).toBe(true);
    expect(isSkin(skin, ...SHIRT)).toBe(false);
    expect(skinModel(rgba, width, height, 1, { ...face, nose: { x: 180, y: 180 } })).toBeNull();
  });

  it("turns uncovered shirt into skin on the arms and shoulders, and into backdrop beside the arms", () => {
    const face = body.face;
    if (!face) throw new Error("no face");
    const skin = skinModel(rgba, width, height, 1, face);
    if (!skin) throw new Error("no skin");
    const out = uncoverOwnClothes(rgba, width, height, 1, body, person, skin);
    // On the upper arm's centre line: skin.
    const arm = pixel(out, 132, 95);
    expect(arm[3]).toBe(255);
    expect(isSkin(skin, arm[0] ?? 0, arm[1] ?? 0, arm[2] ?? 0)).toBe(true);
    // The top of the shoulder: skin.
    expect(isSkin(skin, ...(pixel(out, 115, 64).slice(0, 3) as [number, number, number]))).toBe(true);
    // The sleeve standing off the arm (outside it, beside the body): the wall's colour.
    expect(pixel(out, 148, 75).slice(0, 3)).toEqual(WALL);
    // The face and the backdrop stay as they are.
    expect(pixel(out, 100, 35)[3]).toBe(0);
    expect(pixel(out, 10, 10)[3]).toBe(0);
    // Below the upper chest the garment covers the body: its own clothes are left, never a bare torso.
    expect(pixel(out, 100, 150)[3]).toBe(0);
  });

  it("leaves a forearm's own shaded skin alone", () => {
    const face = body.face;
    if (!face) throw new Error("no face");
    const skin = skinModel(rgba, width, height, 1, face);
    if (!skin) throw new Error("no skin");
    // A bare forearm below the sleeve, its outer edge in shadow (a tint just outside the face's).
    const arm = Uint8ClampedArray.from(rgba);
    for (let y = 125; y < 160; y += 1) {
      for (let x = 126; x <= 140; x += 1) arm.set([...(x >= 138 ? [140, 118, 110] : SKIN), 255], (y * width + x) * 4);
    }
    const withArm = (x: number, y: number) => person(x, y) || (y >= 125 && y < 160 && x >= 126 && x <= 141 ? 1 : 0);
    const out = uncoverOwnClothes(arm, width, height, 1, body, withArm, skin);
    expect(pixel(out, 139, 140)[3]).toBe(0);
    expect(pixel(out, 132, 140)[3]).toBe(0);
  });
});
