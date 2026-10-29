import { describe, expect, it } from "vitest";

import type { Keypoint, Pose } from "@/lib/vision/movenet";
import { bodyAnchors, garmentFit, garmentMesh, garmentToBody, maskBounds, SEAM_PER_JOINTS, SHOULDER_LIFT, triangleTransform, type GarmentFit } from "@/lib/vision/mirror";
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
});
