import { describe, expect, it } from "vitest";

import { hairMask } from "@/lib/tryon/hair";
import type { Keypoint, Pose } from "@/lib/vision/models/movenet";

// Hair over the shoulders, found by shade so the try-on keeps it: a drawn person with dark hair falling
// in two strands past the shoulders, a lighter face and neck, and a top.

const W = 400;
const H = 500;
type RGB = readonly [number, number, number];
const WHITE: RGB = [245, 245, 245];
const SKIN: RGB = [205, 160, 130];
const HAIR: RGB = [30, 24, 20];
const BLUE_TOP: RGB = [70, 100, 170];

const at = (x: number, y: number, score = 0.9): Keypoint => ({ x, y, score });
const unseen = at(0, 0, 0);
const POSE: Pose = {
  nose: at(200, 115),
  leftEye: at(215, 95),
  rightEye: at(185, 95),
  leftEar: unseen,
  rightEar: unseen,
  leftShoulder: at(260, 190),
  rightShoulder: at(140, 190),
  leftElbow: unseen,
  rightElbow: unseen,
  leftWrist: unseen,
  rightWrist: unseen,
  leftHip: unseen,
  rightHip: unseen,
  leftKnee: unseen,
  rightKnee: unseen,
  leftAnkle: unseen,
  rightAnkle: unseen,
};

type Look = { top?: RGB; hair?: RGB; neck?: RGB; neckWidth?: number };

function photo(look: Look = {}) {
  const { top = BLUE_TOP, hair = HAIR, neck = SKIN, neckWidth = 20 } = look;
  const part = (x: number, y: number): RGB | null => {
    const strand = y >= 60 && y <= 240 && (Math.abs(x - 157) <= 8 || Math.abs(x - 243) <= 8);
    if (strand) return hair;
    const head = ((x - 200) / 45) ** 2 + ((y - 100) / 55) ** 2 <= 1;
    if (head) return y < 75 ? hair : SKIN;
    if (y >= 150 && y < 175 && Math.abs(x - 200) <= neckWidth) return neck;
    if (y >= 175 && Math.abs(x - 200) <= 95) return top;
    return null;
  };
  const rgb = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const colour = part(x, y) ?? WHITE;
      rgb.set(colour, (y * W + x) * 3);
    }
  }
  const person = (x: number, y: number) => (part(Math.round(x), Math.round(y)) ? 1 : 0);
  return { rgb, person };
}

function hair(look: Look = {}) {
  const { rgb, person } = photo(look);
  return hairMask(rgb, W, H, POSE, person);
}

describe("hair over the shoulders", () => {
  it("is found from the head down, past the shoulders, and nothing else", () => {
    const found = hair();
    if (!found) throw new Error("no hair found");
    const isHair = (x: number, y: number) => found[y * W + x] === 1;
    expect(isHair(157, 220)).toBe(true); // a strand below the shoulders
    expect(isHair(243, 200)).toBe(true);
    expect(isHair(200, 65)).toBe(true); // the top of the head
    expect(isHair(200, 120)).toBe(false); // the face
    expect(isHair(200, 160)).toBe(false); // the neck
    expect(isHair(200, 260)).toBe(false); // the top
  });

  it("isn't guessed when the hair is as light as the skin", () => {
    expect(hair({ hair: [190, 150, 120] })).toBeNull();
  });

  it("gives up rather than keep a top the colour of the hair", () => {
    expect(hair({ top: [25, 22, 20] })).toBeNull();
  });

  it("gives up rather than keep a neck in shadow as dark as the hair", () => {
    expect(hair({ neck: [35, 28, 24], neckWidth: 50 })).toBeNull();
  });

  it("needs the face", () => {
    const { rgb, person } = photo();
    expect(hairMask(rgb, W, H, { ...POSE, nose: unseen }, person)).toBeNull();
  });
});
