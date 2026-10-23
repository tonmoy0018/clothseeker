import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { DEFAULT_TEMPLATE_CONFIG } from "@/lib/catalog/default-template";
import { alignGarmentPhoto } from "@/lib/garment-photo/align";
import type { Mask } from "@/lib/garment-photo/segment";
import type { PlacementArea } from "@/types/template";

import type { SeedProduct } from "./seed-data";

// Photo templates for the seeded dresses: the catalogue photo for the style it shows, plus the AI style
// pictures in prisma/style-photos/<slug>/ (ai-scripts/generate-style-photos.ts). Every picture is lined
// up (lib/garment-photo/align.ts) and cut into Sleeves / Bodice / Skirt masks.

export const STYLE_PHOTOS_DIR = path.join(process.cwd(), "prisma", "style-photos");
const SEED_PHOTOS_DIR = path.join(process.cwd(), "prisma", "seed-photos");

export type PhotoRegion = "straps" | "bodice" | "skirt";
export const PHOTO_REGIONS: readonly { id: PhotoRegion; label: string }[] = [
  { id: "straps", label: "Sleeves" },
  { id: "bodice", label: "Bodice" },
  { id: "skirt", label: "Skirt" },
];

export type PhotoPicture = {
  side: "front" | "back";
  match: { neckline?: string; sleeveLength: string; dressLength: string };
  /** The lined-up picture, WebP. */
  image: Buffer;
  /** Grey PNG masks; a region missing from the picture (e.g. sleeves on a sleeveless dress) has none. */
  masks: Partial<Record<PhotoRegion, Buffer>>;
  /** Working-size masks, for fitting the print areas. */
  workMasks: Record<PhotoRegion, Mask>;
};

/** The style pictures available for a dress (empty when it has none). */
export async function styleFiles(slug: string): Promise<string[]> {
  const dir = path.join(STYLE_PHOTOS_DIR, slug);
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((f) => /^(front|back)-[a-z0-9-]+\.jpg$/.test(f)).sort();
}

function parseName(file: string, options: typeof DEFAULT_TEMPLATE_CONFIG.styleOptions): PhotoPicture["match"] & { side: "front" | "back" } {
  const name = file.replace(/\.jpg$/, "");
  const side = name.startsWith("front-") ? "front" : "back";
  const rest = name.slice(side.length + 1);
  // Option ids may contain hyphens ("v-neck"), so match known ids from the end.
  const dressLength = options.dressLength.map((o) => o.id).find((id) => rest.endsWith(`-${id}`)) ?? "";
  const beforeLength = rest.slice(0, rest.length - dressLength.length - 1);
  const sleeveLength = options.sleeveLength.map((o) => o.id).find((id) => beforeLength === id || beforeLength.endsWith(`-${id}`)) ?? "";
  const neckline = side === "front" ? beforeLength.slice(0, beforeLength.length - sleeveLength.length - 1) : undefined;
  return { side, neckline, sleeveLength, dressLength };
}

async function picture(raw: Buffer, side: "front" | "back", match: PhotoPicture["match"]): Promise<PhotoPicture> {
  const aligned = await alignGarmentPhoto(raw);
  const byRegion = { straps: aligned.masks.sleeves, bodice: aligned.masks.bodice, skirt: aligned.masks.skirt };
  const workMasks: Record<PhotoRegion, Mask> = { straps: byRegion.straps.work, bodice: byRegion.bodice.work, skirt: byRegion.skirt.work };
  const masks: Partial<Record<PhotoRegion, Buffer>> = {};
  for (const { id } of PHOTO_REGIONS) {
    if (workMasks[id].data.some((v) => v === 1)) masks[id] = byRegion[id].png;
  }
  return { side, match, image: await sharp(aligned.image).webp({ quality: 88 }).toBuffer(), masks, workMasks };
}

/** All pictures for a dress: its catalogue photo (front, its own style) and the AI style pictures. */
export async function photoPictures(product: SeedProduct & { photoStyle: NonNullable<SeedProduct["photoStyle"]> }): Promise<PhotoPicture[]> {
  const pictures: PhotoPicture[] = [await picture(await readFile(path.join(SEED_PHOTOS_DIR, `${product.slug}.jpg`)), "front", product.photoStyle)];
  for (const file of await styleFiles(product.slug)) {
    const { side, ...match } = parseName(file, DEFAULT_TEMPLATE_CONFIG.styleOptions);
    if (!match.sleeveLength || !match.dressLength) continue;
    pictures.push(await picture(await readFile(path.join(STYLE_PHOTOS_DIR, product.slug, file)), side, side === "back" ? { sleeveLength: match.sleeveLength, dressLength: match.dressLength } : match));
  }
  return pictures;
}

// ─── print areas ─────────────────────────────────────────────────────────────

/**
 * Print areas for the lined-up photos, as [area, region it must sit on]. Sizes are the default
 * template's (in cm), placed for the photo framing (shoulders at 6%, waist at 25% of the height).
 */
const PHOTO_AREAS: readonly [PlacementArea, PhotoRegion][] = [
  [{ id: "front-chest", label: "Front chest", side: "front", rect: { x: 0.4385, y: 0.155, w: 0.123, h: 0.071 }, widthCm: 20, heightCm: 15 }, "bodice"],
  [{ id: "front-skirt", label: "Front skirt", side: "front", rect: { x: 0.392, y: 0.29, w: 0.216, h: 0.128 }, widthCm: 35, heightCm: 27 }, "skirt"],
  [{ id: "back-upper", label: "Upper back", side: "back", rect: { x: 0.4075, y: 0.1, w: 0.185, h: 0.107 }, widthCm: 30, heightCm: 25 }, "bodice"],
];

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
export function fitPrintAreas(pictures: readonly PhotoPicture[]): PlacementArea[] {
  const fitted: PlacementArea[] = [];
  for (const [area, region] of PHOTO_AREAS) {
    const masks = pictures.filter((p) => p.side === area.side).map((p) => p.workMasks[region]);
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
