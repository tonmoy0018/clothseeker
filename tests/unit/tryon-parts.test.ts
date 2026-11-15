import { describe, expect, it } from "vitest";

import { hairFromParts, handsFromParts } from "@/lib/tryon/parts";
import type { Keypoint, Pose } from "@/lib/vision/models/movenet";
import { decodeParts, PART, partAt, partMask, PARTS_SIZE, partsInput, type BodyParts, type Part } from "@/lib/vision/models/parts";

// The body-parts model's answer (what each pixel of a person is) and what the try-on keeps from it:
// hair and face, and the hands that are in sight.

const W = 600;
const H = 800;
const at = (x: number, y: number, score = 0.9): Keypoint => ({ x, y, score });
const POSE: Pose = {
  nose: at(300, 110),
  leftEye: at(310, 100),
  rightEye: at(290, 100),
  leftEar: at(320, 105),
  rightEar: at(280, 105),
  leftShoulder: at(360, 200),
  rightShoulder: at(240, 200),
  leftElbow: at(375, 320),
  rightElbow: at(225, 320),
  leftWrist: at(380, 430),
  rightWrist: at(220, 430),
  leftHip: at(340, 430),
  rightHip: at(260, 430),
  leftKnee: at(340, 590),
  rightKnee: at(260, 590),
  leftAnkle: at(340, 740),
  rightAnkle: at(260, 740),
};

/** Parts painted in photo coordinates (rectangles, later ones on top), for a region covering the photo. */
function painted(rects: { part: Part; x0: number; y0: number; x1: number; y1: number }[]): BodyParts {
  const classes = new Uint8Array(PARTS_SIZE * PARTS_SIZE);
  for (let py = 0; py < PARTS_SIZE; py += 1) {
    for (let px = 0; px < PARTS_SIZE; px += 1) {
      const x = ((px + 0.5) / PARTS_SIZE) * W;
      const y = ((py + 0.5) / PARTS_SIZE) * H;
      for (const r of rects) if (x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1) classes[py * PARTS_SIZE + px] = r.part;
    }
  }
  return { classes, region: { left: 0, top: 0, width: W, height: H } };
}

const TOP = { part: PART.clothes, x0: 220, y0: 180, x1: 380, y1: 450 };
const FACE = { part: PART.faceSkin, x0: 270, y0: 80, x1: 330, y1: 150 };
const HAIR_ON_HEAD = { part: PART.hair, x0: 260, y0: 50, x1: 340, y1: 90 };

describe("body-parts model", () => {
  it("feeds the model pixel by pixel, scaled to 0–1, and reads the likeliest class of each pixel", () => {
    const rgba = new Uint8Array(PARTS_SIZE * PARTS_SIZE * 4);
    rgba.set([255, 128, 0, 255], 0);
    expect([...partsInput(rgba, 4).slice(0, 3)].map((v) => Number(v.toFixed(3)))).toEqual([1, 0.502, 0]);
    expect(partsInput(rgba, 4)).toHaveLength(PARTS_SIZE * PARTS_SIZE * 3);

    const scores = new Float32Array(PARTS_SIZE * PARTS_SIZE * 6);
    scores.set([0.1, 2.5, -1, 0, 0.3, 0.2], 0); // pixel 0: hair
    scores.set([-3, -2, -1, -4, -0.5, -6], 6); // pixel 1: clothes (the least negative)
    const classes = decodeParts(scores);
    expect([classes[0], classes[1], classes[2]]).toEqual([PART.hair, PART.clothes, PART.background]);
  });

  it("maps photo pixels into the region it read, and calls everything outside it background", () => {
    const parts: BodyParts = { classes: new Uint8Array(PARTS_SIZE * PARTS_SIZE).fill(PART.clothes), region: { left: 100, top: 200, width: 256, height: 512 } };
    parts.classes[0] = PART.hair;
    expect(partAt(parts, 100.4, 201)).toBe(PART.hair);
    expect(partAt(parts, 200, 400)).toBe(PART.clothes);
    expect(partAt(parts, 99, 400)).toBe(PART.background);
    expect(partAt(parts, 200, 712)).toBe(PART.background);
  });
});

describe("what the try-on keeps, from the body parts", () => {
  it("keeps hair and face, whatever the hair's colour, and nothing else", () => {
    const longHair = [
      { part: PART.hair, x0: 225, y0: 90, x1: 262, y1: 300 },
      { part: PART.hair, x0: 338, y0: 90, x1: 375, y1: 300 },
    ];
    const keep = hairFromParts(painted([TOP, FACE, HAIR_ON_HEAD, ...longHair]), POSE);
    expect(keep?.(240, 250)).toBe(1); // hair over the shoulder
    expect(keep?.(300, 120)).toBe(1); // face
    expect(keep?.(300, 300)).toBe(0); // their top: repainted
    expect(keep?.(20, 20)).toBe(0);
  });

  it("doesn't trust hair that covers the middle of the chest (a top mistaken for hair)", () => {
    expect(hairFromParts(painted([{ ...TOP, part: PART.hair }, FACE]), POSE)).toBeNull();
  });

  it("tells hands in sight from hands in pockets by the skin just past the wrist", () => {
    const leftHand = { part: PART.bodySkin, x0: 360, y0: 420, x1: 400, y1: 470 };
    const trousers = { part: PART.clothes, x0: 190, y0: 400, x1: 410, y1: 760 };
    // The left hand shows skin; the right one is inside the trouser pocket.
    expect(handsFromParts(painted([TOP, trousers, leftHand]), POSE)).toEqual({ left: true, right: false });
    // A wrist the body points didn't find counts as visible, as before.
    expect(handsFromParts(painted([TOP, trousers]), { ...POSE, rightWrist: at(220, 430, 0.1), leftWrist: at(380, 430, 0.1) })).toEqual({ left: true, right: true });
  });
});

describe("one part as a mask of the picture", () => {
  it("stretches the model's classes over their region, background outside it", () => {
    // Clothes on the right half of the model's square, read over a 40×20 region at (10, 10).
    const classes = new Uint8Array(PARTS_SIZE * PARTS_SIZE);
    for (let y = 0; y < PARTS_SIZE; y += 1) for (let x = PARTS_SIZE / 2; x < PARTS_SIZE; x += 1) classes[y * PARTS_SIZE + x] = PART.clothes;
    const mask = partMask({ classes, region: { left: 10, top: 10, width: 40, height: 20 } }, 60, 40, PART.clothes);
    expect(mask.data[20 * 60 + 40]).toBe(1);
    expect(mask.data[20 * 60 + 20]).toBe(0);
    expect(mask.data[35 * 60 + 40]).toBe(0);
    expect(mask.data[5 * 60 + 40]).toBe(0);
  });
});
