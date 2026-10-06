import { z } from "zod";

import { DECORATION_IDS } from "@/lib/catalog/decorations";
import { FONT_IDS } from "@/lib/catalog/fonts";
import { PATTERN_IDS } from "@/lib/catalog/patterns";
import { isSafeObjectKey } from "@/lib/storage/object-key";

// Customization rules attached to a product (CustomizationTemplate.config).
//
// Versioned: rows are stored with `schemaVersion`. Always read them through
// `parseTemplateConfig()`, which upgrades older versions to the current one.
// To change the shape: add a new version schema, an upgrade step, and bump TEMPLATE_CONFIG_VERSION.

export const TEMPLATE_CONFIG_VERSION = 3;

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

// ─── v3 (current) ─────────────────────────────────────────────────────────────
// v2 → v3: regions gained `masks` (where each region is on the garment image) and the
// template gained `allowedDecorations`.

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

export const STYLE_GROUPS = ["neckline", "sleeveLength", "dressLength"] as const;
export type StyleGroup = (typeof STYLE_GROUPS)[number];

const styleOptionList = z.array(styleOptionSchema).min(1, "Add at least one option").max(8);

export const templateConfigSchema = z
  .object({
    schemaVersion: z.literal(3),
    garmentImages: z.object({ front: storageKey.optional(), back: storageKey.optional() }),
    regions: z.array(templateRegionSchema).min(1, "Add at least one region").max(12),
    placementAreas: z.array(placementAreaSchema).max(8),
    styleOptions: z.object({
      neckline: styleOptionList,
      sleeveLength: styleOptionList,
      dressLength: styleOptionList,
    }),
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
    for (const group of STYLE_GROUPS) {
      reportDuplicates(config.styleOptions[group].map((o) => o.id), ["styleOptions", group], "option ids");
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
  return templateConfigSchema.parse(candidate);
}

/** Every storage key referenced by a config (garment images, region masks, style reference images). */
export function templateImageKeys(config: TemplateConfig): string[] {
  const keys = [config.garmentImages.front, config.garmentImages.back];
  for (const region of config.regions) {
    keys.push(region.masks.front, region.masks.back);
  }
  for (const group of STYLE_GROUPS) {
    for (const option of config.styleOptions[group]) {
      keys.push(option.referenceImageKey);
    }
  }
  return keys.filter((k): k is string => typeof k === "string");
}
