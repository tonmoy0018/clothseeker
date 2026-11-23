import sharp from "sharp";

import type { GarmentType } from "@/lib/catalog/garment-types";
import { slugify } from "@/lib/text/slug";
import { MAX_PLACEMENT_AREAS, type PlacementArea } from "@/types/template";

import { alignGarmentPhoto, frameGarmentPhoto, maskPng, PHOTO_HEIGHT, PHOTO_WIDTH, type AlignedPhoto, type PhotoBox } from "./align";
import { backPicture } from "./back";
import { pairName, type PartHint } from "./parts";
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

/** Two grey PNG masks of the same size as one: white where either is. */
async function unionPng(a: Buffer, b: Buffer): Promise<Buffer> {
  const grey = (png: Buffer) => sharp(png).resize(PHOTO_WIDTH, PHOTO_HEIGHT, { fit: "fill" }).extractChannel(0).raw().toBuffer();
  const [one, other] = await Promise.all([grey(a), grey(b)]);
  const both = Buffer.alloc(PHOTO_WIDTH * PHOTO_HEIGHT);
  for (let i = 0; i < both.length; i += 1) both[i] = Math.max(one[i] ?? 0, other[i] ?? 0);
  return sharp(both, { raw: { width: PHOTO_WIDTH, height: PHOTO_HEIGHT, channels: 1 } }).toColourspace("b-w").png({ compressionLevel: 9 }).toBuffer();
}

/** One catalogue picture, lined up like the others and cut into its parts. */
export async function photoPicture(raw: Buffer, type: GarmentType, side: "front" | "back", match: StyleChoice): Promise<PhotoPicture> {
  return pictureFrom(await alignGarmentPhoto(raw, type === "dress" ? "torso" : "shoulders"), type, side, match);
}

/** A part of a customer's own garment: its region id and label, and its mask (grey PNG + working size). */
export type OwnRegion = { id: string; label: string; png: Buffer; work: Mask };

/** A region id from a part's name: lowercase words joined by hyphens, unique, never an area id. */
function regionId(label: string, taken: Set<string>): string {
  const base = slugify(label, 30) || "part";
  let id = base;
  for (let n = 2; taken.has(id) || id === "whole-front" || id === "whole-back" || id.endsWith("-print"); n += 1) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/**
 * A customer's own garment photo (lib/own-dress): the whole garment, cut out onto a studio backdrop and
 * cut into ITS parts (the AI's `hints`: jacket body, inner shirt…), or, without usable hints, into the
 * shape-based parts (sleeves, bodice, skirt for dresses; one body for tops), with a back made from the
 * front (back.ts). Print areas cover the whole front, the sizeable parts and the whole back.
 */
export async function ownPhotoPicture(
  raw: Buffer,
  type: GarmentType,
  within?: PhotoBox,
  hints?: readonly PartHint[],
): Promise<{ image: Buffer; regions: OwnRegion[]; printAreas: PlacementArea[]; back: { image: Buffer; masks: Record<string, Buffer> } }> {
  const framed = await frameGarmentPhoto(raw, type === "dress" ? "torso" : "shoulders", within, hints);
  const taken = new Set<string>();
  let regions: OwnRegion[];
  if (framed.hintedParts && hints) {
    // The two sides of a pair (left and right sleeve) become one part.
    const found = new Map<string, { label: string; pair: string | null; png: Buffer; work: Mask; sides: number }>();
    for (const [i, part] of framed.hintedParts.entries()) {
      const hint = hints[i];
      if (!hint || part.area === 0 || !part.work.data.some((v) => v === 1)) continue;
      const pair = pairName(hint.label);
      const key = (pair ?? hint.label).toLowerCase();
      const other = found.get(key);
      if (other) {
        found.set(key, { ...other, png: await unionPng(other.png, part.png), work: union(other.work, part.work), sides: other.sides + 1 });
      } else {
        found.set(key, { label: hint.label, pair, png: part.png, work: part.work, sides: 1 });
      }
    }
    regions = [...found.values()].map((part) => {
      const label = part.sides > 1 && part.pair ? part.pair : part.label;
      return { id: regionId(label, taken), label, png: part.png, work: part.work };
    });
  } else {
    const picture = await pictureFrom(framed, type, "front", {});
    regions = await Promise.all(
      photoRegionsFor(type).flatMap(({ id, label }) => {
        const work = picture.workMasks[id];
        const png = picture.masks[id];
        return work && png ? [Promise.resolve({ id: regionId(id, taken), label, png, work })] : [];
      }),
    );
  }
  const back = await backPicture(framed.image, framed.alpha, regions);
  const size = (r: OwnRegion) => r.work.data.reduce((m, v) => m + v, 0);
  const total = regions.reduce((n, r) => n + size(r), 0);
  // Each part big enough to print on gets its own area, the biggest first, within a template's 8 areas.
  const parts = regions
    .filter((r) => size(r) >= total * 0.1)
    .sort((a, b) => size(b) - size(a))
    .slice(0, MAX_PLACEMENT_AREAS - 2);
  const printAreas = [
    ...printArea("whole-front", "Whole front", regions.map((r) => r.work), framed.pictureCm),
    ...parts.flatMap((r) => printArea(`${r.id}-print`, r.label.slice(0, 40), [r.work], framed.pictureCm)),
    ...printArea("whole-back", "Whole back", back.masks.map((m) => m.work), framed.pictureCm, "back"),
  ];
  return {
    image: await sharp(framed.image).webp({ quality: 90 }).toBuffer(),
    regions,
    printAreas,
    back: { image: back.image, masks: Object.fromEntries(back.masks.map((m) => [m.id, m.png])) },
  };
}

async function pictureFrom(aligned: AlignedPhoto, type: GarmentType, side: "front" | "back", match: StyleChoice): Promise<PhotoPicture> {
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
/** One print area over everything on these masks (front), trimmed to the fabric; none if they're empty. */
function printArea(id: string, label: string, masks: readonly Mask[], cm: { w: number; h: number }, side: "front" | "back" = "front"): PlacementArea[] {
  const round = (v: number) => Math.round(v * 10_000) / 10_000;
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
}

export function printAreasFor(type: GarmentType, pictures: readonly PhotoPicture[]): PlacementArea[] {
  const cm = PICTURE_CM[type === "dress" ? "dress" : "top"];
  const area = (id: string, label: string, side: "front" | "back", regions: readonly PhotoRegion[]): PlacementArea[] =>
    printArea(id, label, pictures.filter((p) => p.side === side).flatMap((p) => regions.flatMap((r) => p.workMasks[r] ?? [])), cm, side);
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
