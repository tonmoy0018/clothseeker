import { z } from "zod";

// Customization rules attached to a product (CustomizationTemplate.config).
// Phase 1 defines the minimum the seed needs; Phase 2 (template editor) extends it.
// Bump TEMPLATE_CONFIG_VERSION and add a migration step whenever the shape changes.

export const TEMPLATE_CONFIG_VERSION = 1;

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const hexColor = z.string().regex(/^#[0-9a-f]{6}$/i);

export const templateRegionSchema = z.object({
  /** Stable id used by DesignSpec, e.g. "bodice". */
  id: slug,
  label: z.string().min(1).max(40),
  recolorable: z.boolean(),
});

export const placementAreaSchema = z.object({
  id: slug,
  label: z.string().min(1).max(40),
  side: z.enum(["front", "back"]),
  /** Real-world printable size in centimetres. */
  widthCm: z.number().positive().max(100),
  heightCm: z.number().positive().max(150),
});

export const styleOptionSchema = z.object({
  id: slug,
  label: z.string().min(1).max(40),
  addOnPriceMinor: z.number().int().min(0),
});

export const templateConfigSchema = z
  .object({
    schemaVersion: z.literal(TEMPLATE_CONFIG_VERSION),
    regions: z.array(templateRegionSchema).min(1).max(12),
    placementAreas: z.array(placementAreaSchema).max(8),
    styleOptions: z.object({
      neckline: z.array(styleOptionSchema).min(1).max(8),
      sleeveLength: z.array(styleOptionSchema).min(1).max(8),
      dressLength: z.array(styleOptionSchema).min(1).max(8),
    }),
    allowedColors: z.array(z.object({ name: z.string().min(1).max(30), hex: hexColor })).min(1).max(40),
  })
  .superRefine((config, ctx) => {
    const ids = [...config.regions.map((r) => r.id), ...config.placementAreas.map((a) => a.id)];
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (duplicates.length > 0) {
      ctx.addIssue({ code: "custom", message: `Duplicate region/area ids: ${[...new Set(duplicates)].join(", ")}` });
    }
  });

export type TemplateConfig = z.infer<typeof templateConfigSchema>;
