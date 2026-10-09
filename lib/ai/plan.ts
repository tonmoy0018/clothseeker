import { z } from "zod";

import { PATTERN_IDS, type PatternId } from "@/lib/catalog/patterns";
import { validateDesignAgainstTemplate, type DesignContext } from "@/lib/design/validate";
import { designSpecSchema, MAX_LAYERS_PER_AREA, MAX_LAYERS_TOTAL, type DesignLayer, type DesignSpec } from "@/types/design-spec";
import { STYLE_GROUPS, type PlacementArea, type TemplateConfig } from "@/types/template";

import { findBrandTerm } from "./brands";
import type { PlanConstraints, PlanSummary } from "./types";

// The planner's answer is untrusted JSON. This module:
//   1. parses it leniently (clipping long strings) with Zod,
//   2. fits every value to the template (nearest allowed color, known ids only),
//   3. turns each variation into a DesignSpec built on the customer's current design,
//   4. keeps only specs that pass the same validateDesignAgainstTemplate() as a manual design.
// So whatever a provider returns, the AI can never produce a design the template doesn't allow.

export const OPTIONS_PER_ROUND = 4;

const hex = z
  .string()
  .trim()
  .regex(/^#?[0-9a-f]{6}$/i)
  .transform((v) => `#${v.replace("#", "").toLowerCase()}`);
const clip = (max: number) => z.string().transform((v) => v.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, max));
const shortId = z.string().trim().max(40);

export const planVariationSchema = z.object({
  title: clip(40).pipe(z.string().min(1)),
  summary: clip(160).optional().default(""),
  parts: z
    .array(z.object({ regionId: shortId, color: hex, pattern: z.object({ id: shortId, color: hex }).nullish() }))
    .max(12)
    .optional()
    .default([]),
  styleOptions: z
    .object({ neckline: shortId.nullish(), sleeveLength: shortId.nullish(), dressLength: shortId.nullish() })
    .nullish(),
  text: z.object({ content: clip(60), fontId: shortId, color: hex }).nullish(),
  motif: z.object({ prompt: clip(200).pipe(z.string().min(3)), color: hex }).nullish(),
});

export const planSchema = z.object({ variations: z.array(planVariationSchema).min(1).max(8) });

export type PlanVariation = z.infer<typeof planVariationSchema>;

// ─── template → planner vocabulary ───────────────────────────────────────────

export function planConstraints(template: TemplateConfig, dressName: string): PlanConstraints {
  return {
    dressName,
    regions: template.regions.filter((r) => r.recolorable).map((r) => ({ id: r.id, label: r.label })),
    colors: template.allowedColors.map((c) => ({ name: c.name, hex: c.hex.toLowerCase() })),
    patterns: [...template.allowedPatterns],
    fonts: [...template.allowedFonts],
    styleOptions: {
      neckline: template.styleOptions.neckline.map((o) => ({ id: o.id, label: o.label })),
      sleeveLength: template.styleOptions.sleeveLength.map((o) => ({ id: o.id, label: o.label })),
      dressLength: template.styleOptions.dressLength.map((o) => ({ id: o.id, label: o.label })),
    },
    layersAllowed: template.placementAreas.length > 0,
  };
}

export function summarizeSpec(spec: DesignSpec): PlanSummary {
  const text = spec.layers.find((l) => l.kind === "text");
  return {
    parts: Object.entries(spec.parts).map(([regionId, part]) => ({
      regionId,
      color: part.color,
      pattern: part.pattern ? { id: part.pattern.id, color: part.pattern.color } : null,
    })),
    styleOptions: { ...spec.styleOptions },
    text: text?.kind === "text" ? text.text.content : null,
  };
}

// ─── fitting values to the template ──────────────────────────────────────────

function rgb(value: string): [number, number, number] {
  const n = Number.parseInt(value.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The allowed color closest to `value` (RGB distance). Allowed colors are lowercase hex. */
export function nearestColor(value: string, allowed: readonly string[]): string | null {
  const [r, g, b] = rgb(value);
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of allowed) {
    const [cr, cg, cb] = rgb(candidate);
    const distance = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

const isPattern = (id: string): id is PatternId => PATTERN_IDS.some((p) => p === id);

/** Where AI-made layers go: the motif in the largest front area, text in another front area if there is one. */
function layerSlots(template: TemplateConfig): { motif: PlacementArea; text: PlacementArea } | null {
  const bySize = [...template.placementAreas].sort(
    (a, b) => Number(b.side === "front") - Number(a.side === "front") || b.widthCm * b.heightCm - a.widthCm * a.heightCm,
  );
  const motif = bySize[0];
  if (!motif) {
    return null;
  }
  const text = bySize.find((a) => a.id !== motif.id && a.side === motif.side) ?? motif;
  return { motif, text };
}

/** AI layers are rebuilt every round, so a follow-up replaces them instead of stacking more. */
export const AI_LAYER_PREFIX = "ai-";

export type VariationContext = DesignContext & {
  template: TemplateConfig;
  /** Stored motif image for this variation (design-assets, the customer's ai/ folder), if one was made. */
  motifKey: string | null;
};

/** One variation → a template-valid DesignSpec on top of `base`, or null if it can't be made valid. */
export function variationToSpec(base: DesignSpec, variation: PlanVariation, ctx: VariationContext): DesignSpec | null {
  const { template } = ctx;
  const colors = template.allowedColors.map((c) => c.hex.toLowerCase());
  const recolorable = new Set(template.regions.filter((r) => r.recolorable).map((r) => r.id));

  const parts: DesignSpec["parts"] = { ...base.parts };
  for (const part of variation.parts) {
    const color = nearestColor(part.color, colors);
    if (!recolorable.has(part.regionId) || !color) {
      continue;
    }
    const patternId = part.pattern?.id;
    const patternColor = part.pattern ? nearestColor(part.pattern.color, colors) : null;
    parts[part.regionId] =
      patternId && isPattern(patternId) && template.allowedPatterns.includes(patternId) && patternColor
        ? { color, pattern: { id: patternId, color: patternColor } }
        : { color };
  }

  const styleOptions = { ...base.styleOptions };
  for (const group of STYLE_GROUPS) {
    const wanted = variation.styleOptions?.[group];
    if (wanted && template.styleOptions[group].some((o) => o.id === wanted)) {
      styleOptions[group] = wanted;
    }
  }

  const kept = base.layers.filter((l) => !l.id.startsWith(AI_LAYER_PREFIX));
  const aiLayers: DesignLayer[] = [];
  const slots = layerSlots(template);
  if (slots) {
    const shared = slots.motif.id === slots.text.id;
    const fontId = template.allowedFonts.find((f) => f === variation.text?.fontId) ?? template.allowedFonts[0];
    const color = variation.text ? nearestColor(variation.text.color, colors) : null;
    const content = variation.text?.content ?? "";
    const text = content && !findBrandTerm(content) && fontId && color ? { content, fontId, color } : null;
    if (ctx.motifKey && variation.motif && !findBrandTerm(variation.motif.prompt)) {
      const box = shared && text ? { x: 0.15, y: 0.04, w: 0.7, h: 0.6 } : { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
      aiLayers.push({ id: `${AI_LAYER_PREFIX}motif`, areaId: slots.motif.id, kind: "image", rotation: 0, ...box, image: { assetKey: ctx.motifKey } });
    }
    if (text) {
      const box = shared && aiLayers.length > 0 ? { x: 0.05, y: 0.68, w: 0.9, h: 0.28 } : { x: 0.05, y: 0.25, w: 0.9, h: 0.5 };
      aiLayers.push({ id: `${AI_LAYER_PREFIX}text`, areaId: slots.text.id, kind: "text", rotation: 0, ...box, text });
    }
  }

  const layers = [...kept];
  for (const layer of aiLayers) {
    const inArea = layers.filter((l) => l.areaId === layer.areaId).length;
    if (layers.length < MAX_LAYERS_TOTAL && inArea < MAX_LAYERS_PER_AREA) {
      layers.push(layer);
    }
  }

  const check = (spec: DesignSpec): DesignSpec | null => {
    const parsed = designSpecSchema.safeParse(spec);
    if (!parsed.success) {
      return null;
    }
    return validateDesignAgainstTemplate(parsed.data, template, ctx).length === 0 ? parsed.data : null;
  };
  const candidate = { ...base, parts, styleOptions, layers };
  // If an AI layer is the problem, fall back to the colors and style alone.
  return check(candidate) ?? check({ ...candidate, layers: kept });
}

export type PlannedOption = { title: string; summary: string; variation: PlanVariation };

/** Parses the raw planner answer. Throws ZodError when it isn't a plan at all. */
export function parsePlan(raw: unknown): PlannedOption[] {
  return planSchema
    .parse(raw)
    .variations.slice(0, OPTIONS_PER_ROUND)
    .map((variation) => ({ title: variation.title, summary: variation.summary, variation }));
}
