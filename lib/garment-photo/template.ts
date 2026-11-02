import sharp from "sharp";

import type { GarmentType } from "@/lib/catalog/garment-types";
import type { PlacementArea } from "@/types/template";

import { alignGarmentPhoto, maskPng, PHOTO_HEIGHT, PHOTO_WIDTH } from "./align";
import type { Mask } from "./segment";
import type { StyleChoice } from "./style-files";

// A garment photo made ready for a photo template: lined up (align.ts), cut into part masks (Sleeves /
// Bodice / Skirt for dresses, one Body mask for shirts and panjabis), and print areas fitted to the
// fabric. Used by the seed for the catalogue's customizable items and by the worker for a customer's
// own dress (lib/own-dress).

export type PhotoRegion = "straps" | "bodice" | "skirt" | "body";

/** The parts a photo of this garment type is cut into. */
export function photoRegionsFor(type: GarmentType): readonly { id: PhotoRegion; label: string }[] {
  return type === "dress"
    ? [
        { id: "straps", label: "Sleeves" },
        { id: "bodice", label: "Bodice" },
        { id: "skirt", label: "Skirt" },
      ]
    : // Long sleeves hang against the body in shirt and panjabi photos, so they can't be cut apart
      // reliably: the whole garment is one part.
      [{ id: "body", label: "Body" }];
}

export type PhotoPicture = {
  side: "front" | "back";
  match: StyleChoice;
  /** The lined-up picture, WebP. */
  image: Buffer;
  /** Grey PNG masks; a region missing from the picture (e.g. sleeves on a sleeveless dress) has none. */
  masks: Partial<Record<PhotoRegion, Buffer>>;
  /** Working-size masks, for fitting the print areas. */
  workMasks: Partial<Record<PhotoRegion, Mask>>;
};

function union(a: Mask, b: Mask): Mask {
  return { ...a, data: a.data.map((v, i) => (v || b.data[i] ? 1 : 0)) };
}

/** One picture, lined up and cut into its parts. */
export async function photoPicture(raw: Buffer, type: GarmentType, side: "front" | "back", match: StyleChoice): Promise<PhotoPicture> {
  const aligned = await alignGarmentPhoto(raw, type === "dress" ? "torso" : "shoulders");
  const workMasks: Partial<Record<PhotoRegion, Mask>> = {};
  const masks: Partial<Record<PhotoRegion, Buffer>> = {};
  const add = async (id: PhotoRegion, work: Mask, png?: Buffer) => {
    workMasks[id] = work;
    if (work.data.some((v) => v === 1)) masks[id] = png ?? (await maskPng(work, PHOTO_WIDTH, PHOTO_HEIGHT));
  };
  if (type === "dress") {
    await add("straps", aligned.masks.sleeves.work, aligned.masks.sleeves.png);
    await add("bodice", aligned.masks.bodice.work, aligned.masks.bodice.png);
    await add("skirt", aligned.masks.skirt.work, aligned.masks.skirt.png);
  } else {
    await add("body", union(union(aligned.masks.bodice.work, aligned.masks.skirt.work), aligned.masks.sleeves.work));
  }
  return { side, match, image: await sharp(aligned.image).webp({ quality: 88 }).toBuffer(), masks, workMasks };
}

// ─── print areas ─────────────────────────────────────────────────────────────

/**
 * Real size of the whole lined-up picture in cm, from its framing: a dress's shoulders-to-waist (19% of
 * the height) is about 40 cm; a shirt's shoulder width (36% of the width) about 46 cm.
 */
const PICTURE_CM: Record<"dress" | "top", { w: number; h: number }> = {
  dress: { w: (PHOTO_WIDTH * 40) / (0.19 * PHOTO_HEIGHT), h: 40 / 0.19 },
  top: { w: 46 / 0.36, h: (PHOTO_HEIGHT * 46) / (0.36 * PHOTO_WIDTH) },
};

type Box = { x0: number; y0: number; x1: number; y1: number };

/** The bounding box (fractions of the picture) of everything on any of these masks, or null if empty. */
function boundingBox(masks: readonly Mask[]): Box | null {
  let box: Box | null = null;
  for (const mask of masks) {
    for (let y = 0; y < mask.height; y += 1) {
      for (let x = 0; x < mask.width; x += 1) {
        if (!mask.data[y * mask.width + x]) continue;
        const fx = x / mask.width;
        const fy = y / mask.height;
        box = box ? { x0: Math.min(box.x0, fx), y0: Math.min(box.y0, fy), x1: Math.max(box.x1, fx), y1: Math.max(box.y1, fy) } : { x0: fx, y0: fy, x1: fx, y1: fy };
      }
    }
  }
  return box;
}

/**
 * Large print areas that cover the whole front, each part and the whole back of every style picture, and
 * trim to the fabric: customers can place items anywhere on the garment, and whatever falls off the
 * chosen style's outline isn't printed.
 */
export function printAreasFor(type: GarmentType, pictures: readonly PhotoPicture[]): PlacementArea[] {
  const cm = PICTURE_CM[type === "dress" ? "dress" : "top"];
  const round = (v: number) => Math.round(v * 10_000) / 10_000;
  const area = (id: string, label: string, side: "front" | "back", regions: readonly PhotoRegion[]): PlacementArea[] => {
    const masks = pictures.filter((p) => p.side === side).flatMap((p) => regions.flatMap((r) => p.workMasks[r] ?? []));
    const box = boundingBox(masks);
    if (!box) return [];
    const pad = 0.005;
    const x = Math.max(0, box.x0 - pad);
    const y = Math.max(0, box.y0 - pad);
    const w = Math.min(1, box.x1 + pad) - x;
    const h = Math.min(1, box.y1 + pad) - y;
    const widthCm = Math.min(100, Math.round(w * cm.w * 2) / 2);
    const heightCm = Math.min(150, Math.round(h * cm.h * 2) / 2);
    return [{ id, label, side, rect: { x: round(x), y: round(y), w: round(w), h: round(h) }, widthCm, heightCm, clipToFabric: true }];
  };
  const all = photoRegionsFor(type).map((r) => r.id);
  return [
    // Area ids differ from region ids (bodice, skirt…): a template's ids must be unique across both.
    ...area("whole-front", "Whole front", "front", all),
    ...(type === "dress"
      ? [...area("bodice-print", "Bodice", "front", ["bodice"]), ...area("skirt-print", "Skirt", "front", ["skirt"]), ...area("sleeves-print", "Sleeves", "front", ["straps"])]
      : []),
    ...area("whole-back", "Whole back", "back", all),
  ];
}
