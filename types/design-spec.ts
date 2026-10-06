import { z } from "zod";

import { DECORATION_IDS } from "@/lib/catalog/decorations";
import { FONT_IDS } from "@/lib/catalog/fonts";
import { PATTERN_IDS } from "@/lib/catalog/patterns";
import { Size } from "@/lib/generated/prisma/enums";
import { isSafeObjectKey } from "@/lib/storage/object-key";

// DesignSpec: everything needed to price, render and produce a customer's custom dress.
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
  decoration: z.object({ id: z.enum(DECORATION_IDS), color: hex }),
});

export const designLayerSchema = z.discriminatedUnion("kind", [textLayerSchema, imageLayerSchema, decorationLayerSchema]);

export const MAX_LAYERS_TOTAL = 30;
export const MAX_LAYERS_PER_AREA = 12;

export const designSpecSchema = z.object({
  version: z.literal(DESIGN_SPEC_VERSION),
  productId: z.uuid(),
  templateId: z.uuid(),
  templateVersion: z.number().int().positive(),
  size: z.enum(Size),
  styleOptions: z.object({ neckline: id, sleeveLength: id, dressLength: id }),
  /** Per recolorable region: a color, optionally with a pattern drawn in a second color. */
  parts: z.record(id, z.object({ color: hex, pattern: z.object({ id: z.enum(PATTERN_IDS), color: hex }).optional() })),
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
