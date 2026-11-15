import { randomUUID } from "node:crypto";

import { defaultTemplateConfig } from "@/lib/catalog/default-template";
import { GARMENT_TYPES, type GarmentType } from "@/lib/catalog/garment-types";
import { SIZE_ORDER } from "@/lib/catalog/size-chart";
import type { PrismaClient } from "@/lib/db/client";
import { saveDesign } from "@/lib/design/service";
import { SegmentationError } from "@/lib/garment-photo/segment";
import { ownDressName, readStyle, type GarmentReading } from "@/lib/own-dress/read";
import { ownPhotoPicture } from "@/lib/garment-photo/template";
import type { StorageAdapter } from "@/lib/storage/adapter";
import { BUCKETS } from "@/lib/storage/buckets";
import { buildObjectKey } from "@/lib/storage/object-key";
import type { DesignSpec } from "@/types/design-spec";
import { parseTemplateConfig, templateConfigSchema, templateImageKeys, templateStyleGroups, type TemplateConfig } from "@/types/template";

// A customer's own dress, made from their photo (decided 2026-11-02): the whole garment is cut out onto
// a studio backdrop like the catalogue's photos and cut into parts (lib/garment-photo/template.ts), and
// becomes a PRIVATE product with its own template, owned by the customer. They may recolour it, add text,
// decorations, prints and finishes, and ask the AI design box for ideas (rounds count towards the usual
// daily limit), but not change its cut (one style option per group: as in the photo). It's made
// to order: the team prices it through a quote (lib/quotes), so it's never sold directly.

/** The one style option of each group: the garment's cut as it is in the photo. */
export const AS_PHOTO = "as-photo";
const AS_PHOTO_OPTION = { id: AS_PHOTO, label: "As in your photo", addOnPriceMinor: 0 };

export class OwnDressError extends Error {
  override readonly name = "OwnDressError";
}

export type OwnDressInput = {
  customerId: string;
  /** The customer's photo (design-assets, under their own references/). */
  referenceKey: string;
  photo: Buffer;
  /** What the customer said it is, or "auto": what the AI read (a dress when it couldn't tell). */
  garmentType: GarmentType | "auto";
  /** "Make this exact dress": the design is saved as it is, ready for a quote. Otherwise a draft to edit. */
  exact: boolean;
  /** What the AI read in the photo (lib/own-dress/read.ts), or null when it wasn't asked or couldn't answer. */
  reading: GarmentReading | null;
  /** `photo` is an AI product shot made from the customer's photo (the team is told so). */
  shot?: boolean;
  /** `photo` is an AI rendering of the customer's drawing (`referenceKey`, the team's reference). */
  sketch?: boolean;
};

/** The style option labels say what the AI saw ("V-neck"), else "As in your photo". */
function styleOption(reading: GarmentReading | null, group: string) {
  const seen = readStyle(reading, group);
  return { ...AS_PHOTO_OPTION, label: seen ? `${seen.charAt(0).toUpperCase()}${seen.slice(1)}`.slice(0, 40) : AS_PHOTO_OPTION.label };
}

/**
 * The template of a customer's own dress: their photo's front, cut into ITS parts (each recolourable on
 * its own), nothing to choose but colours and additions.
 */
function ownDressConfig(
  type: GarmentType,
  picture: { image: string; regions: { id: string; label: string; mask: string }[] },
  placementAreas: TemplateConfig["placementAreas"],
  reading: GarmentReading | null,
): TemplateConfig {
  const base = defaultTemplateConfig(type);
  const style = Object.fromEntries(templateStyleGroups(base).map((group) => [group, AS_PHOTO]));
  const masks = Object.fromEntries(picture.regions.map((r) => [r.id, r.mask]));
  return templateConfigSchema.parse({
    ...base,
    styleOptions: Object.fromEntries(templateStyleGroups(base).map((group) => [group, [styleOption(reading, group)]])),
    placementAreas,
    garmentImages: { front: picture.image },
    regions: picture.regions.map(({ id, label, mask }) => ({ id, label, recolorable: true, masks: { front: mask } })),
    styleVariants: [{ side: "front", match: style, image: picture.image, masks }],
    recolor: "shade",
    defaultStyle: style,
  });
}

/**
 * Builds the customer's own dress from their photo: the PRIVATE product, its sizes, its template and a
 * design on it (saved for "exact", a draft otherwise). Throws OwnDressError when no garment is found.
 */
export async function buildOwnDress(db: PrismaClient, storage: StorageAdapter, input: OwnDressInput): Promise<{ productId: string; designId: string }> {
  const { reading } = input;
  const type = input.garmentType === "auto" ? (reading?.garmentType ?? "dress") : input.garmentType;
  const groups = templateStyleGroups(defaultTemplateConfig(type));
  const style = Object.fromEntries(groups.map((group) => [group, AS_PHOTO]));
  // Just the garment inside the box the AI found, split into the parts it named; failing that, anything
  // in the photo with the shape-based parts.
  const hints = reading?.parts ?? [];
  const attempts = [
    ...(reading?.box || hints.length > 0 ? [{ within: reading?.box ?? undefined, hints }] : []),
    { within: undefined, hints: [] },
  ];
  let found = null;
  for (const { within, hints: partHints } of attempts) {
    try {
      const attempt = await ownPhotoPicture(input.photo, type, within, partHints);
      if (attempt.regions.length > 0) {
        found = attempt;
        break;
      }
    } catch (error) {
      if (!(error instanceof SegmentationError)) throw error;
    }
  }
  if (!found) {
    throw new OwnDressError("no garment found");
  }
  const picture = found;

  const productId = randomUUID();
  const uploaded: string[] = [];
  const upload = async (data: Buffer, extension: "webp" | "png") => {
    const key = buildObjectKey(BUCKETS.productMedia, { ownerId: productId, category: "template", extension });
    await storage.put(BUCKETS.productMedia, key, data, extension === "png" ? "image/png" : "image/webp");
    uploaded.push(key);
    return key;
  };
  try {
    const image = await upload(picture.image, "webp");
    const regions = [];
    for (const region of picture.regions) regions.push({ id: region.id, label: region.label, mask: await upload(region.png, "png") });
    const config = ownDressConfig(type, { image, regions }, picture.printAreas, reading);
    const category = await db.category.findFirst({ orderBy: { sortOrder: "asc" }, select: { id: true } });
    if (!category) throw new Error("no category to file the dress under");
    const noun = GARMENT_TYPES[type].noun;

    const templateId = await db.$transaction(async (tx) => {
      await tx.product.create({
        data: {
          id: productId,
          slug: `own-${productId}`,
          name: ownDressName(reading, type),
          description: [
            reading?.description ?? `Your own ${noun}, from your ${input.sketch ? "drawing" : "photo"}.`,
            input.sketch ? "Picture: an AI rendering of the customer's sketch (their sketch is the reference: make what it shows)." : null,
            input.shot ? "Picture: an AI product shot made from the customer's photo (their own photo is the reference)." : null,
          ]
            .filter((s): s is string => s !== null)
            .join(" "),
          categoryId: category.id,
          garmentType: type,
          status: "PRIVATE",
          ownerId: input.customerId,
          imageKeys: [image],
          // Every size; the price comes from the team's quote.
          variants: {
            create: SIZE_ORDER.map((size) => ({ sku: `own-${productId}-${size}`.toLowerCase(), size, colorName: "As in your photo", colorHex: "#808080", priceMinor: 0, stock: 0 })),
          },
        },
      });
      const template = await tx.customizationTemplate.create({ data: { productId, config, isActive: true, aiEnabled: true }, select: { id: true, version: true } });
      return template;
    });

    const spec: DesignSpec = {
      version: 1,
      productId,
      templateId: templateId.id,
      templateVersion: templateId.version,
      size: "M",
      styleOptions: style,
      parts: {},
      layers: [],
      startedFrom: "photo",
      referencePhotoKey: input.referenceKey,
    };
    if (input.exact) {
      const saved = await saveDesign(db, storage, { id: input.customerId, role: "CUSTOMER" }, { spec });
      return { productId, designId: saved.designId };
    }
    const design = await db.design.create({
      data: {
        customerId: input.customerId,
        productId,
        templateId: templateId.id,
        templateVersion: templateId.version,
        spec,
        startedFrom: "PHOTO",
        referencePhotoKey: input.referenceKey,
        status: "DRAFT",
      },
      select: { id: true },
    });
    return { productId, designId: design.id };
  } catch (error) {
    // Nothing half-made is left behind: the product (with its sizes, template and designs) and its pictures.
    await db.product.deleteMany({ where: { id: productId, status: "PRIVATE" } }).catch(() => undefined);
    await storage.remove(BUCKETS.productMedia, uploaded).catch(() => undefined);
    throw error;
  }
}

/** Removes a customer's own dress that was just built (its job didn't finish): designs, product, pictures. */
export async function removeOwnDress(db: PrismaClient, storage: StorageAdapter, productId: string): Promise<void> {
  const product = await db.product.findFirst({ where: { id: productId, status: "PRIVATE" }, select: { imageKeys: true, template: { select: { config: true } } } });
  if (!product) return;
  const designs = await db.design.findMany({ where: { productId }, select: { previewKey: true } });
  await db.$transaction([db.design.deleteMany({ where: { productId } }), db.product.delete({ where: { id: productId } })]);
  const previews = designs.flatMap((d) => (d.previewKey ? [d.previewKey] : []));
  await storage.remove(BUCKETS.designAssets, previews).catch(() => undefined);
  const pictures = product.template ? templateImageKeys(parseTemplateConfig(product.template.config)) : [];
  await storage.remove(BUCKETS.productMedia, [...new Set([...product.imageKeys, ...pictures])]).catch(() => undefined);
}
