import { z } from "zod";

import { DECORATION_IDS } from "@/lib/catalog/decorations";
import { GARMENT_TYPE_IDS, GARMENT_TYPES, STYLE_GROUP_IDS, STYLE_GROUP_LABEL, styleGroupsOf, type StyleGroup } from "@/lib/catalog/garment-types";
import { FONT_IDS } from "@/lib/catalog/fonts";
import { PATTERN_IDS } from "@/lib/catalog/patterns";
import { isSafeObjectKey } from "@/lib/storage/object-key";

// Customization rules attached to a product (CustomizationTemplate.config).
//
// Versioned: rows are stored with `schemaVersion`. Always read them through
// `parseTemplateConfig()`, which upgrades older versions to the current one.
// To change the shape: add a new version schema, an upgrade step, and bump TEMPLATE_CONFIG_VERSION.

export const TEMPLATE_CONFIG_VERSION = 6;

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "Use lowercase letters, numbers and hyphens");
const label = z.string().trim().min(1, "Required").max(40);
const hexColor = z.string().regex(/^#[0-9a-f]{6}$/i, "Use a 6-digit hex color like #1f6f50");
const priceMinor = z.number().int().min(0).max(10_000_000);
const storageKey = z.string().max(200).refine(isSafeObjectKey, "Invalid image reference");
const fraction = z.number().min(0).max(1);

// ─── v1 (Phase 1 seed) ────────────────────────────────────────────────────────

const styleOptionV1 = z.object({ id, label, addOnPriceMinor: priceMinor });

export const templateConfigV1Schema = z.object({
  schemaVersion: z.literal(1),
  regions: z.array(z.object({ id, label, recolorable: z.boolean() })).min(1).max(12),
  placementAreas: z
    .array(
      z.object({
        id,
        label,
        side: z.enum(["front", "back"]),
        widthCm: z.number().positive().max(100),
        heightCm: z.number().positive().max(150),
      }),
    )
    .max(8),
  styleOptions: z.object({
    neckline: z.array(styleOptionV1).min(1).max(8),
    sleeveLength: z.array(styleOptionV1).min(1).max(8),
    dressLength: z.array(styleOptionV1).min(1).max(8),
  }),
  allowedColors: z.array(z.object({ name: z.string().min(1).max(30), hex: hexColor })).min(1).max(40),
});

// ─── v6 (current) ─────────────────────────────────────────────────────────────
// v2 → v3: regions gained `masks` (where each region is on the garment image) and the
// template gained `allowedDecorations`.
// v3 → v4: optional `styleVariants`, garment pictures (+ masks) for particular style choices, so the
// preview changes shape when the customer picks a neckline, sleeve or length.
// v4 → v5: `recolor` (how colours go onto the garment pictures: "multiply" for light drawings,
// "shade" for photos of any colour; see lib/design/shade.ts) and an optional `defaultStyle`.
// v5 → v6: `garmentType` (lib/catalog/garment-types.ts). Its style groups decide which style options
// the template has: a dress has neckline / sleeves / length, a shirt collar / sleeves / fit.

export const templateRegionSchema = z.object({
  id,
  label,
  recolorable: z.boolean(),
  /** Grayscale mask images aligned with the garment images: white = this region. */
  masks: z.object({ front: storageKey.optional(), back: storageKey.optional() }),
});

export const placementRectSchema = z
  .object({ x: fraction, y: fraction, w: fraction.positive(), h: fraction.positive() })
  .refine((r) => r.x + r.w <= 1.000001 && r.y + r.h <= 1.000001, "The area must stay inside the garment image");

export const placementAreaSchema = z.object({
  id,
  label,
  side: z.enum(["front", "back"]),
  /** Position on the garment image, as fractions of its width/height. */
  rect: placementRectSchema,
  /** Real-world printable size in centimetres. */
  widthCm: z.number().positive().max(100),
  heightCm: z.number().positive().max(150),
});

export const styleOptionSchema = z.object({
  id,
  label,
  addOnPriceMinor: priceMinor,
  referenceImageKey: storageKey.optional(),
});

export type { GarmentType, StyleGroup } from "@/lib/catalog/garment-types";
const styleGroup = z.enum(STYLE_GROUP_IDS);

const styleOptionList = z.array(styleOptionSchema).min(1, "Add at least one option").max(8);

/**
 * A garment picture for some style choices. Groups left out of `match` match any option, so a back
 * view can ignore the neckline. The most specific matching variant wins (see lib/design/garment-variant.ts);
 * with none, the template's own `garmentImages` and region masks are used.
 */
export const styleVariantSchema = z.object({
  side: z.enum(["front", "back"]),
  match: z.partialRecord(styleGroup, id),
  image: storageKey,
  /** Region masks aligned with `image`, by region id. A region without one isn't on this picture. */
  masks: z.record(id, storageKey),
});

export const MAX_STYLE_VARIANTS = 256;

export const templateConfigSchema = z
  .object({
    schemaVersion: z.literal(6),
    garmentType: z.enum(GARMENT_TYPE_IDS),
    garmentImages: z.object({ front: storageKey.optional(), back: storageKey.optional() }),
    regions: z.array(templateRegionSchema).min(1, "Add at least one region").max(12),
    placementAreas: z.array(placementAreaSchema).max(8),
    /** Options for each of the garment type's style groups (exactly those groups). */
    styleOptions: z.partialRecord(styleGroup, styleOptionList),
    allowedColors: z
      .array(z.object({ name: z.string().trim().min(1).max(30), hex: hexColor }))
      .min(1, "Allow at least one color")
      .max(40),
    allowedPatterns: z.array(z.enum(PATTERN_IDS)).max(PATTERN_IDS.length),
    allowedFonts: z.array(z.enum(FONT_IDS)).max(FONT_IDS.length),
    allowedDecorations: z.array(z.enum(DECORATION_IDS)).max(DECORATION_IDS.length),
    addOns: z.object({
      textMinor: priceMinor,
      imageMinor: priceMinor,
      patternMinor: priceMinor,
      decorationMinor: priceMinor,
    }),
    styleVariants: z.array(styleVariantSchema).max(MAX_STYLE_VARIANTS),
    recolor: z.enum(["multiply", "shade"]),
    /** Style a new design starts with (e.g. the one the dress's photo shows). Defaults to each group's first option. */
    defaultStyle: z.partialRecord(styleGroup, id).optional(),
  })
  .superRefine((config, ctx) => {
    const reportDuplicates = (values: string[], path: (string | number)[], what: string) => {
      const dupes = [...new Set(values.filter((v, i) => values.indexOf(v) !== i))];
      if (dupes.length > 0) {
        ctx.addIssue({ code: "custom", path, message: `Duplicate ${what}: ${dupes.join(", ")}` });
      }
    };
    reportDuplicates(
      [...config.regions.map((r) => r.id), ...config.placementAreas.map((a) => a.id)],
      ["regions"],
      "region/area ids",
    );
    const groups = styleGroupsOf(config.garmentType);
    for (const group of groups) {
      const options = config.styleOptions[group];
      if (!options) {
        ctx.addIssue({ code: "custom", path: ["styleOptions", group], message: `Add the ${STYLE_GROUP_LABEL[group].toLowerCase()} options` });
      } else {
        reportDuplicates(options.map((o) => o.id), ["styleOptions", group], "option ids");
      }
    }
    for (const group of Object.keys(config.styleOptions)) {
      if (!groups.some((g) => g === group)) {
        ctx.addIssue({ code: "custom", path: ["styleOptions", group], message: `A ${GARMENT_TYPES[config.garmentType].noun} has no ${group} options` });
      }
    }
    reportDuplicates(config.allowedColors.map((c) => c.name.toLowerCase()), ["allowedColors"], "color names");
    reportDuplicates(config.allowedPatterns, ["allowedPatterns"], "patterns");
    reportDuplicates(config.allowedFonts, ["allowedFonts"], "fonts");
    reportDuplicates(config.allowedDecorations, ["allowedDecorations"], "decorations");
  });

export type TemplateConfig = z.infer<typeof templateConfigSchema>;
export type PlacementArea = z.infer<typeof placementAreaSchema>;
export type TemplateRegion = z.infer<typeof templateRegionSchema>;
export type StyleOption = z.infer<typeof styleOptionSchema>;
export type StyleVariant = z.infer<typeof styleVariantSchema>;

export const DEFAULT_ADD_ONS: TemplateConfig["addOns"] = {
  textMinor: 15_000,
  imageMinor: 25_000,
  patternMinor: 20_000,
  decorationMinor: 10_000,
};

/** Default positions for v1 areas, which had no rectangle. */
const DEFAULT_RECTS: Record<"front" | "back", { x: number; y: number; w: number; h: number }[]> = {
  front: [
    { x: 0.4, y: 0.2, w: 0.2, h: 0.14 },
    { x: 0.32, y: 0.5, w: 0.36, h: 0.3 },
  ],
  back: [{ x: 0.38, y: 0.18, w: 0.24, h: 0.18 }],
};

function upgradeV1(v1: z.infer<typeof templateConfigV1Schema>): unknown {
  const used = { front: 0, back: 0 };
  return {
    schemaVersion: 2,
    garmentImages: {},
    regions: v1.regions,
    placementAreas: v1.placementAreas.map((area) => {
      const rects = DEFAULT_RECTS[area.side];
      const rect = rects[used[area.side]++ % rects.length] ?? { x: 0.3, y: 0.3, w: 0.4, h: 0.2 };
      return { ...area, rect };
    }),
    styleOptions: v1.styleOptions,
    allowedColors: v1.allowedColors,
    allowedPatterns: [],
    allowedFonts: ["inter"],
    addOns: DEFAULT_ADD_ONS,
  };
}

/** v2 → v3. Shape is checked loosely here; the final v3 parse validates everything. */
const templateConfigV2Shape = z.looseObject({
  schemaVersion: z.literal(2),
  regions: z.array(z.looseObject({})),
});

function upgradeV2(v2: z.infer<typeof templateConfigV2Shape>): unknown {
  return {
    ...v2,
    schemaVersion: 3,
    regions: v2.regions.map((region) => ({ ...region, masks: {} })),
    allowedDecorations: [...DECORATION_IDS],
  };
}

/** v3 → v4: no style pictures yet. */
const templateConfigV3Shape = z.looseObject({ schemaVersion: z.literal(3) });

function upgradeV3(v3: z.infer<typeof templateConfigV3Shape>): unknown {
  return { ...v3, schemaVersion: 4, styleVariants: [] };
}

/** v5 → v6: every template so far is a dress. */
const templateConfigV5Shape = z.looseObject({ schemaVersion: z.literal(5) });

function upgradeV5(v5: z.infer<typeof templateConfigV5Shape>): unknown {
  return { ...v5, schemaVersion: 6, garmentType: "dress" };
}

/** v4 → v5: existing templates recolour by multiplying. */
const templateConfigV4Shape = z.looseObject({ schemaVersion: z.literal(4) });

function upgradeV4(v4: z.infer<typeof templateConfigV4Shape>): unknown {
  return { ...v4, schemaVersion: 5, recolor: "multiply" };
}

export class TemplateConfigError extends Error {
  override readonly name = "TemplateConfigError";
}

/** Reads a stored config of any supported version and returns the current shape. */
export function parseTemplateConfig(raw: unknown): TemplateConfig {
  const version = z.object({ schemaVersion: z.number().int() }).safeParse(raw);
  if (!version.success) {
    throw new TemplateConfigError("Template config has no schemaVersion");
  }
  const v = version.data.schemaVersion;
  if (v < 1 || v > TEMPLATE_CONFIG_VERSION) {
    throw new TemplateConfigError(`Unsupported template schemaVersion ${v}`);
  }
  let candidate: unknown = raw;
  if (v === 1) {
    candidate = upgradeV1(templateConfigV1Schema.parse(candidate));
  }
  if (v <= 2) {
    candidate = upgradeV2(templateConfigV2Shape.parse(candidate));
  }
  if (v <= 3) {
    candidate = upgradeV3(templateConfigV3Shape.parse(candidate));
  }
  if (v <= 4) {
    candidate = upgradeV4(templateConfigV4Shape.parse(candidate));
  }
  if (v <= 5) {
    candidate = upgradeV5(templateConfigV5Shape.parse(candidate));
  }
  return templateConfigSchema.parse(candidate);
}

/** Every storage key referenced by a config (garment images, region masks, style reference images, style pictures). */
export function templateImageKeys(config: TemplateConfig): string[] {
  const keys = [config.garmentImages.front, config.garmentImages.back];
  for (const region of config.regions) {
    keys.push(region.masks.front, region.masks.back);
  }
  for (const group of templateStyleGroups(config)) {
    for (const option of styleOptionsFor(config, group)) {
      keys.push(option.referenceImageKey);
    }
  }
  for (const variant of config.styleVariants) {
    keys.push(variant.image, ...Object.values(variant.masks));
  }
  // Variants share pictures (e.g. one skirt mask for every neckline), so list each key once.
  return [...new Set(keys.filter((k): k is string => typeof k === "string"))];
}

/** The style groups a template offers (its garment type's), in display order. */
export function templateStyleGroups(config: Pick<TemplateConfig, "garmentType">): readonly StyleGroup[] {
  return styleGroupsOf(config.garmentType);
}

/** A template's options for one style group (empty if it has none). */
export function styleOptionsFor(config: Pick<TemplateConfig, "styleOptions">, group: StyleGroup): StyleOption[] {
  return config.styleOptions[group] ?? [];
}
