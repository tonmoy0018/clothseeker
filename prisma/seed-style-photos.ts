import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { parseStyleFileName } from "@/lib/garment-photo/style-files";
import { photoPicture, type PhotoPicture } from "@/lib/garment-photo/template";

import type { SeedProduct } from "./seed-data";

// Photo templates for the seeded customizable items: the catalogue photo for the style it shows, plus the
// AI style pictures in prisma/style-photos/<slug>/ (ai-scripts/generate-style-photos.ts). Every picture is
// lined up (lib/garment-photo/align.ts) and cut into masks: Sleeves / Bodice / Skirt for dresses, and
// one Body mask (the whole garment) for shirts and panjabis.

export const STYLE_PHOTOS_DIR = path.join(process.cwd(), "prisma", "style-photos");
const SEED_PHOTOS_DIR = path.join(process.cwd(), "prisma", "seed-photos");

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

/** All pictures for an item: its catalogue photo (front, its own style) and the AI style pictures. */
export async function photoPictures(product: SeedProduct & { photoStyle: NonNullable<SeedProduct["photoStyle"]> }): Promise<PhotoPicture[]> {
  const type = product.garmentType ?? "dress";
  const pictures: PhotoPicture[] = [await photoPicture(await readFile(catalogPhotoPath(product.slug)), type, "front", product.photoStyle)];
  for (const file of await styleFiles(product)) {
    const parsed = parseStyleFileName(type, file);
    if (parsed) pictures.push(await photoPicture(await readFile(path.join(STYLE_PHOTOS_DIR, product.slug, file)), type, parsed.side, parsed.match));
  }
  return pictures;
}
