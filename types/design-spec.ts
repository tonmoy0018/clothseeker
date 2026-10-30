import { z } from "zod";

import { DECORATION_IDS, OUTLINE_WIDTH, REPEAT_COUNT } from "@/lib/catalog/decorations";
import { FONT_IDS } from "@/lib/catalog/fonts";
import { STYLE_GROUP_IDS } from "@/lib/catalog/garment-types";
import { PATTERN_IDS } from "@/lib/catalog/patterns";
import { Size } from "@/lib/generated/prisma/enums";
import { isSafeObjectKey } from "@/lib/storage/object-key";

// DesignSpec: everything needed to price, render and produce a customer's custom garment.
//
// Stored as JSON in Design.spec and snapshotted onto OrderItem.designSpec. Never trusted from the
// client: the server re-parses it AND revalidates it against the live template
// (lib/design/validate.ts) before saving, pricing or ordering.
//
// Versioned: read stored specs through parseDesignSpec(). To change the shape, add a version.

export const DESIGN_SPEC_VERSION = 1;

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const hex = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i)
  .transform((v) => v.toLowerCase());
const storageKey = z.string().max(200).refine(isSafeObjectKey, "Invalid file reference");
const fraction = z.number().min(0).max(1);

/** Printable text only: no control characters, at most 60 characters. */
const textContent = z
  .string()
  .trim()
  .min(1, "Text can't be empty")
  .max(60, "Text can be at most 60 characters")
  .refine((v) => !/[\u0000-\u001f\u007f-\u009f]/.test(v), "Text contains unsupported characters");

/** Position inside the placement area, as fractions of the area; rotation is about the box centre. */
const layerBox = {
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  areaId: id,
  x: fraction,
  y: fraction,
  w: fraction.positive(),
  h: fraction.positive(),
  rotation: z.number().min(-180).max(180),
};

export const textLayerSchema = z.object({
  ...layerBox,
  kind: z.literal("text"),
  text: z.object({ content: textContent, fontId: z.enum(FONT_IDS), color: hex }),
});

export const imageLayerSchema = z.object({
  ...layerBox,
  kind: z.literal("image"),
  /** design-assets key; must belong to the design's customer (checked in validate.ts). */
  image: z.object({ assetKey: storageKey }),
});

export const decorationLayerSchema = z.object({
  ...layerBox,
  kind: z.literal("decoration"),
  decoration: z.object({
    id: z.enum(DECORATION_IDS),
    color: hex,
    /** Colour of the shape's detail (flower centre, bow knot, butterfly body, leaf vein). */
    detail: hex.optional(),
    style: z.enum(["filled", "outline"]).optional(),
    outline: z.number().int().min(OUTLINE_WIDTH.min).max(OUTLINE_WIDTH.max).optional(),
    mirror: z.boolean().optional(),
    /** A row of repeats across the box (a border); `curve` > 0 sags in the middle, < 0 arches. */
    repeat: z.object({ count: z.number().int().min(REPEAT_COUNT.min).max(REPEAT_COUNT.max), curve: z.number().min(-1).max(1) }).optional(),
  }),
});

/** All-over print tile size: the motif repeats every `tileCm` across the part. */
export const PRINT_TILE_CM = { min: 3, max: 40 } as const;
const tileCm = z.number().min(PRINT_TILE_CM.min).max(PRINT_TILE_CM.max);

/** A motif repeated across a whole part, like printed fabric. */
export const partPrintSchema = z.discriminatedUnion("kind", [
  /** design-assets key; must belong to the design's customer (checked in validate.ts). */
  z.object({ kind: z.literal("image"), assetKey: storageKey, tileCm }),
  z.object({ kind: z.literal("decoration"), id: z.enum(DECORATION_IDS), color: hex, tileCm }),
]);
export type PartPrint = z.infer<typeof partPrintSchema>;

export const designLayerSchema = z.discriminatedUnion("kind", [textLayerSchema, imageLayerSchema, decorationLayerSchema]);

export const MAX_LAYERS_TOTAL = 30;
/** Decoration motifs across the whole design (a border counts each repeat), to keep rendering quick. */
export const MAX_MOTIFS_TOTAL = 80;
export const MAX_LAYERS_PER_AREA = 12;

export const designSpecSchema = z.object({
  version: z.literal(DESIGN_SPEC_VERSION),
  productId: z.uuid(),
  templateId: z.uuid(),
  templateVersion: z.number().int().positive(),
  size: z.enum(Size),
  /** The chosen option for each of the template's style groups (validated against the template). */
  styleOptions: z.partialRecord(z.enum(STYLE_GROUP_IDS), id),
  /**
   * Per recolorable region: a color, optionally with either a pattern drawn in a second color or an
   * all-over print (the customer's image or a decoration repeated across the part).
   */
  parts: z.record(
    id,
    z
      .object({ color: hex, pattern: z.object({ id: z.enum(PATTERN_IDS), color: hex }).optional(), print: partPrintSchema.optional() })
      .refine((part) => !(part.pattern && part.print), "A part can have a pattern or an all-over print, not both"),
  ),
  layers: z.array(designLayerSchema).max(MAX_LAYERS_TOTAL, `A design can have at most ${MAX_LAYERS_TOTAL} layers`),
  startedFrom: z.enum(["shop", "photo", "description"]),
  referencePhotoKey: storageKey.optional(),
});

export type DesignSpec = z.infer<typeof designSpecSchema>;
export type DesignLayer = z.infer<typeof designLayerSchema>;
export type DesignPart = DesignSpec["parts"][string];

export class DesignSpecError extends Error {
  override readonly name = "DesignSpecError";
}

/** Reads a stored or submitted spec of any supported version. Throws ZodError for bad shapes. */
export function parseDesignSpec(raw: unknown): DesignSpec {
  const version = z.object({ version: z.number().int() }).safeParse(raw);
  if (!version.success) {
    throw new DesignSpecError("Design has no version");
  }
  if (version.data.version !== DESIGN_SPEC_VERSION) {
    throw new DesignSpecError(`Unsupported design version ${version.data.version}`);
  }
  return designSpecSchema.parse(raw);
}
