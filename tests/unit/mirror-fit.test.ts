import { describe, expect, it } from "vitest";

import { splitGarment, type Mask, type RgbImage } from "@/lib/garment-photo/segment";
import { closeMask, fillSpecks, recolourBackdrop, recoverGarment } from "@/lib/vision/garment-fill";
import type { Keypoint, Pose } from "@/lib/vision/movenet";
import { bodyAnchors, garmentFit, garmentToBody, MAX_WIDEN, sleeveMesh, withLooseSleeves, type GarmentFit, type SleeveFit } from "@/lib/vision/mirror";

// Making the live mirror's garment look worn: hung from the shoulder seams (collars stand above them),
// covering the person's own clothes out to the arms, shoulders squared to a person's, sleeves joined to
// the body, long sleeves kept whole, and the garment's coloured parts and edges cleaned up.

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

function maskOf(width: number, height: number, inside: (x: number, y: number) => boolean): Mask {
  const mask: Mask = { data: new Uint8Array(width * height), width, height };
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) mask.data[y * width + x] = inside(x, y) ? 1 : 0;
  return mask;
}

/** A shirt-like body (no sleeves): shoulders at row 40, 80 px wide, down to row 180; optionally a collar band above. */
const shirt = (collar: boolean) => maskOf(120, 200, (x, y) => (y >= 40 && y < 180 && x >= 20 && x < 100) || (collar && y >= 36 && y < 40 && x >= 50 && x < 70));

describe("hanging a garment from its shoulder seams", () => {
  it("lets a collar stand above the shoulders, and uses the top row otherwise", () => {
    expect(garmentFit(splitGarment(shirt(true))).shoulderY).toBe(40);
    expect(garmentFit(splitGarment(shirt(true))).top).toBe(36);
    expect(garmentFit(splitGarment(shirt(false))).shoulderY).toBe(40);
  });

  it("measures how far the shoulders slope", () => {
    // Level beside the neck, then sloping down to the shoulder points.
    const sloped = maskOf(120, 200, (x, y) => y >= 40 + Math.max(0, Math.abs(x - 60) - 15) && y < 180 && x >= 20 && x < 100);
    expect(garmentFit(splitGarment(sloped)).shoulderDrop ?? 0).toBeGreaterThan(4);
    expect(garmentFit(splitGarment(shirt(false))).shoulderDrop).toBe(0);
  });
});

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
  // The body, 110 px either side of the centre on every row (about 60 camera px for the test pose).
  rowHalfWidth: Array.from({ length: 600 }, (_, y) => (y >= 20 && y <= 560 ? 110 : 0)),
};

describe("fitting the garment to the person", () => {
  it("reaches under arms hanging beside the body, but not arms held away", () => {
    const body = bodyAnchors(pose());
    if (!body) throw new Error("no body");
    // Arms at the sides (the left elbow about 70 px from the centre line): the body widens to reach them.
    const map = garmentToBody(FIT, body);
    const plainMap = garmentToBody({ ...FIT, rowHalfWidth: undefined }, body);
    const axis = map(FIT.centreX, 300);
    const edge = map(FIT.centreX + 110, 300);
    const plain = plainMap(FIT.centreX + 110, 300);
    expect(edge.x).toBeGreaterThan(plain.x + 3);
    expect(edge.x - axis.x).toBeLessThanOrEqual((plain.x - axis.x) * MAX_WIDEN + 0.5);
    // Arms held out wide: no widening.
    const out = bodyAnchors(pose({ leftElbow: at(700, 300), leftWrist: at(800, 330) }));
    if (!out) throw new Error("no body");
    expect(garmentToBody(FIT, out)(FIT.centreX + 110, 300).x).toBeCloseTo(garmentToBody({ ...FIT, rowHalfWidth: undefined }, out)(FIT.centreX + 110, 300).x, 3);
  });

  it("squares sloping shoulders up to a person's, leaving the neck and chest", () => {
    const body = bodyAnchors(pose());
    if (!body) throw new Error("no body");
    const sloped = { ...FIT, shoulderDrop: 30 };
    const shoulderPoint = FIT.centreX + FIT.shoulderWidth * 0.5;
    expect(garmentToBody(sloped, body)(shoulderPoint, 40).y).toBeLessThan(garmentToBody(FIT, body)(shoulderPoint, 40).y - 5);
    expect(garmentToBody(sloped, body)(FIT.centreX, 40).y).toBeCloseTo(garmentToBody(FIT, body)(FIT.centreX, 40).y, 3);
    expect(garmentToBody(sloped, body)(shoulderPoint, 400).y).toBeCloseTo(garmentToBody(FIT, body)(shoulderPoint, 400).y, 3);
  });

  it("joins a sleeve to the body exactly at the shoulder", () => {
    const sleeve: SleeveFit = { side: "left", root: { x: 320, y: 34 }, end: { x: 330, y: 400 }, halfWidth: 25, length: 366 };
    const body = bodyAnchors(pose({ leftElbow: at(660, 250), leftWrist: at(760, 250) }));
    if (!body) throw new Error("no body");
    const map = garmentToBody(FIT, body);
    const mesh = sleeveMesh(FIT, sleeve, body);
    // Mesh points above the root (t < 0) land where the body would put them: no step at the shoulder.
    const capPoints = mesh.flatMap((t) => t.src.map((p, i) => ({ p, d: t.dst[i] }))).filter(({ p }) => p.y < sleeve.root.y - 5);
    expect(capPoints.length).toBeGreaterThan(0);
    for (const { p, d } of capPoints) {
      const onBody = map(p.x, p.y);
      expect(Math.hypot((d?.x ?? 0) - onBody.x, (d?.y ?? 0) - onBody.y)).toBeLessThan(0.01);
    }
  });
});

describe("keeping long sleeves whole", () => {
  const fit = (garment: Mask, sleeves: Mask) => garmentFit({ ...splitGarment(garment), sleeves });

  it("adds sleeve pieces the garment finder left in the body, but never the body's own sides", () => {
    // A tunic: body 60–140, upper sleeves 30–50 and 150–170 (rows 30–100) in the sleeve mask; below them
    // the forearms hang apart from the body (a 5 px gap) to row 160.
    const garment = maskOf(200, 240, (x, y) => (y >= 30 && y < 230 && x >= 60 && x < 140) || (y >= 30 && y < 160 && ((x >= 30 && x < 55) || (x >= 145 && x < 170))));
    const sleeves = maskOf(200, 240, (x, y) => y >= 30 && y < 100 && ((x >= 30 && x < 55) || (x >= 145 && x < 170)));
    const added = withLooseSleeves(garment, sleeves, fit(garment, sleeves));
    expect(added.data[140 * 200 + 40]).toBe(1); // a forearm
    expect(added.data[140 * 200 + 160]).toBe(1);
    expect(added.data[140 * 200 + 100]).toBe(0); // the body
    expect(added.data[200 * 200 + 135]).toBe(0);
    // A short-sleeved shirt: nothing below the sleeves, the body's sides stay body.
    const short = maskOf(200, 240, (x, y) => (y >= 30 && y < 230 && x >= 60 && x < 140) || (y >= 30 && y < 70 && ((x >= 35 && x < 60) || (x >= 140 && x < 165))));
    const shortSleeves = maskOf(200, 240, (x, y) => y >= 30 && y < 70 && ((x >= 35 && x < 60) || (x >= 140 && x < 165)));
    const kept = withLooseSleeves(short, shortSleeves, fit(short, shortSleeves));
    expect(kept.data.reduce((a, b) => a + b, 0)).toBe(shortSleeves.data.reduce((a, b) => a + b, 0));
  });
});

describe("cleaning up the garment picture", () => {
  const image = (width: number, height: number, paint: (x: number, y: number) => [number, number, number]): RgbImage => {
    const data = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) data.set(paint(x, y), (y * width + x) * 3);
    return { data, width, height };
  };

  it("adds a coloured placket and collar, but not a grey mannequin neck", () => {
    // Grey backdrop; a green body (rows 20–90) with a pale green placket down the middle (not in the
    // mask) and a maroon collar band above it; a cream mannequin neck above the collar.
    const picture = image(100, 100, (x, y) => {
      if (y >= 20 && y < 90 && x >= 20 && x < 80) return x >= 46 && x < 54 && y < 60 ? [150, 200, 120] : [60, 140, 60];
      if (y >= 16 && y < 20 && x >= 40 && x < 60) return [110, 30, 40];
      if (y < 16 && x >= 44 && x < 56) return [230, 224, 210];
      return [225, 225, 228];
    });
    const found = maskOf(100, 100, (x, y) => y >= 20 && y < 90 && x >= 20 && x < 80 && !(x >= 46 && x < 54 && y < 60));
    const recovered = recoverGarment(picture, found, 90);
    expect(recovered.data[40 * 100 + 50]).toBe(1); // placket
    expect(recovered.data[18 * 100 + 50]).toBe(1); // collar band
    expect(recovered.data[10 * 100 + 50]).toBe(0); // mannequin neck
    expect(recovered.data[50 * 100 + 10]).toBe(0); // backdrop
  });

  it("seals small notches and holes, and gives backdrop-coloured edge pixels the fabric's colour", () => {
    const notched = maskOf(60, 60, (x, y) => x >= 10 && x < 50 && y >= 10 && y < 50 && !(x >= 48 && y >= 28 && y < 31));
    expect(closeMask(notched, 2).data[29 * 60 + 49]).toBe(1);
    const holed = maskOf(60, 60, (x, y) => x >= 10 && x < 50 && y >= 10 && y < 50 && !(x === 30 && y === 30));
    expect(fillSpecks(holed, 4).data[30 * 60 + 30]).toBe(1);
    const picture = image(60, 60, (x, y) => (x >= 10 && x < 50 && y >= 10 && y < 50 && !(x >= 47 && y >= 28 && y < 31) ? [30, 40, 90] : [225, 225, 228]));
    const garment = maskOf(60, 60, (x, y) => x >= 10 && x < 50 && y >= 10 && y < 50);
    recolourBackdrop(picture, garment, 2);
    const p = 29 * 60 + 48;
    expect([picture.data[p * 3], picture.data[p * 3 + 1], picture.data[p * 3 + 2]]).toEqual([30, 40, 90]);
  });
});
