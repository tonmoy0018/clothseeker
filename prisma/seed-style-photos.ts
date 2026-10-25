import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import type { GarmentType } from "@/lib/catalog/garment-types";
import { alignGarmentPhoto, maskPng, PHOTO_HEIGHT, PHOTO_WIDTH } from "@/lib/garment-photo/align";
import type { Mask } from "@/lib/garment-photo/segment";
import { parseStyleFileName, type StyleChoice } from "@/lib/garment-photo/style-files";
import type { PlacementArea } from "@/types/template";

import type { SeedProduct } from "./seed-data";

// Photo templates for the seeded customizable items: the catalogue photo for the style it shows, plus the
// AI style pictures in prisma/style-photos/<slug>/ (ai-scripts/generate-style-photos.ts). Every picture is
// lined up (lib/garment-photo/align.ts) and cut into masks: Sleeves / Bodice / Skirt for dresses, and
// Body / Sleeves for shirts and panjabis.

export const STYLE_PHOTOS_DIR = path.join(process.cwd(), "prisma", "style-photos");
const SEED_PHOTOS_DIR = path.join(process.cwd(), "prisma", "seed-photos");

export type PhotoRegion = "straps" | "bodice" | "skirt" | "body" | "sleeves";

/** The parts a photo of this garment type is cut into. */
export function photoRegionsFor(type: GarmentType): readonly { id: PhotoRegion; label: string }[] {
  return type === "dress"
    ? [
        { id: "straps", label: "Sleeves" },
        { id: "bodice", label: "Bodice" },
        { id: "skirt", label: "Skirt" },
      ]
    : [
        { id: "body", label: "Body" },
        { id: "sleeves", label: "Sleeves" },
      ];
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

export function catalogPhotoPath(slug: string): string {
  return path.join(SEED_PHOTOS_DIR, `${slug}.jpg`);
}

/** The style pictures available for an item (empty when it has none). */
export async function styleFiles(product: Pick<SeedProduct, "slug" | "garmentType">): Promise<string[]> {
  const dir = path.join(STYLE_PHOTOS_DIR, product.slug);
  if (!existsSync(dir)) return [];
  const type = product.garmentType ?? "dress";
  return (await readdir(dir)).filter((f) => parseStyleFileName(type, f) !== null).sort();
}

function union(a: Mask, b: Mask): Mask {
  return { ...a, data: a.data.map((v, i) => (v || b.data[i] ? 1 : 0)) };
}

async function picture(raw: Buffer, type: GarmentType, side: "front" | "back", match: StyleChoice): Promise<PhotoPicture> {
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
    // Shirts and panjabis have no skirt: their body is bodice and skirt together.
    await add("body", union(aligned.masks.bodice.work, aligned.masks.skirt.work));
    await add("sleeves", aligned.masks.sleeves.work, aligned.masks.sleeves.png);
  }
  return { side, match, image: await sharp(aligned.image).webp({ quality: 88 }).toBuffer(), masks, workMasks };
}

/** All pictures for an item: its catalogue photo (front, its own style) and the AI style pictures. */
export async function photoPictures(product: SeedProduct & { photoStyle: NonNullable<SeedProduct["photoStyle"]> }): Promise<PhotoPicture[]> {
  const type = product.garmentType ?? "dress";
  const pictures: PhotoPicture[] = [await picture(await readFile(catalogPhotoPath(product.slug)), type, "front", product.photoStyle)];
  for (const file of await styleFiles(product)) {
    const parsed = parseStyleFileName(type, file);
    if (parsed) pictures.push(await picture(await readFile(path.join(STYLE_PHOTOS_DIR, product.slug, file)), type, parsed.side, parsed.match));
  }
  return pictures;
}

// ─── print areas ─────────────────────────────────────────────────────────────

/**
 * Print areas for the lined-up photos, as [area, region it must sit on], placed for the photo framing.
 * Dresses: shoulders at 6% and waist at 25% of the height. Shirts and panjabis: shoulders at 6% and a
 * shoulder width of 36% of the picture (about 7 px per cm at 900 px wide).
 */
const PHOTO_AREAS: Record<GarmentType, readonly [PlacementArea, PhotoRegion][]> = {
  dress: [
    [{ id: "front-chest", label: "Front chest", side: "front", rect: { x: 0.4385, y: 0.155, w: 0.123, h: 0.071 }, widthCm: 20, heightCm: 15 }, "bodice"],
    [{ id: "front-skirt", label: "Front skirt", side: "front", rect: { x: 0.392, y: 0.29, w: 0.216, h: 0.128 }, widthCm: 35, heightCm: 27 }, "skirt"],
    [{ id: "back-upper", label: "Upper back", side: "back", rect: { x: 0.4075, y: 0.1, w: 0.185, h: 0.107 }, widthCm: 30, heightCm: 25 }, "bodice"],
  ],
  shirt: [
    // The wearer's left chest is on the viewer's right.
    [{ id: "chest", label: "Chest", side: "front", rect: { x: 0.54, y: 0.13, w: 0.078, h: 0.048 }, widthCm: 10, heightCm: 8 }, "body"],
    [{ id: "back-yoke", label: "Back yoke", side: "back", rect: { x: 0.3835, y: 0.09, w: 0.233, h: 0.072 }, widthCm: 30, heightCm: 12 }, "body"],
  ],
  panjabi: [
    [{ id: "placket", label: "Front placket", side: "front", rect: { x: 0.4535, y: 0.1, w: 0.093, h: 0.108 }, widthCm: 12, heightCm: 18 }, "body"],
    [{ id: "back-upper", label: "Upper back", side: "back", rect: { x: 0.391, y: 0.1, w: 0.218, h: 0.108 }, widthCm: 28, heightCm: 18 }, "body"],
  ],
};

function covers(mask: Mask, rect: PlacementArea["rect"]): boolean {
  const x0 = Math.floor(rect.x * mask.width);
  const x1 = Math.ceil((rect.x + rect.w) * mask.width) - 1;
  const y0 = Math.floor(rect.y * mask.height);
  const y1 = Math.ceil((rect.y + rect.h) * mask.height) - 1;
  let inside = 0;
  let total = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      total += 1;
      inside += mask.data[y * mask.width + x] ?? 0;
    }
  }
  return total > 0 && inside / total >= 0.99;
}

/**
 * Each print area, shrunk around its centre (cm shrink with it) until it sits on its region in nearly
 * every picture of that side (one odd AI picture shouldn't shrink it for all). An area that can't fit
 * at 60% of its size is left out.
 */
export function fitPrintAreas(type: GarmentType, pictures: readonly PhotoPicture[]): PlacementArea[] {
  const fitted: PlacementArea[] = [];
  for (const [area, region] of PHOTO_AREAS[type]) {
    const masks = pictures.filter((p) => p.side === area.side).flatMap((p) => p.workMasks[region] ?? []);
    if (masks.length === 0) continue;
    const needed = Math.ceil(masks.length * 0.85);
    for (let scale = 1; scale >= 0.6 - 1e-9; scale -= 0.05) {
      const w = area.rect.w * scale;
      const h = area.rect.h * scale;
      const rect = { x: area.rect.x + (area.rect.w - w) / 2, y: area.rect.y + (area.rect.h - h) / 2, w, h };
      if (masks.filter((m) => covers(m, rect)).length >= needed) {
        const round = (v: number) => Math.round(v * 10_000) / 10_000;
        fitted.push({ ...area, rect: { x: round(rect.x), y: round(rect.y), w: round(rect.w), h: round(rect.h) }, widthCm: Math.round(area.widthCm * scale), heightCm: Math.round(area.heightCm * scale) });
        break;
      }
    }
  }
  return fitted;
}
