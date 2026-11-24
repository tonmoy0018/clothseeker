import { z } from "zod";

import { DECORATIONS, type DecorationId } from "@/lib/catalog/decorations";
import { PATTERN_IDS, type PatternId } from "@/lib/catalog/patterns";
import { validateDesignAgainstTemplate, type DesignContext } from "@/lib/design/validate";
import { designSpecSchema, MAX_LAYERS_PER_AREA, MAX_LAYERS_TOTAL, type DesignLayer, type DesignSpec } from "@/types/design-spec";
import { STYLE_GROUP_IDS } from "@/lib/catalog/garment-types";
import { styleOptionsFor, templateStyleGroups, type PlacementArea, type TemplateConfig } from "@/types/template";

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

/** Where on the garment an item goes, as the customer would say it. Left and right are the wearer's. */
export const PLACEMENT_ACROSS = ["wearer-left", "centre", "wearer-right"] as const;
export const PLACEMENT_DOWN = ["top", "middle", "bottom"] as const;
export const PLACEMENT_SIZES = ["small", "medium", "large"] as const;
const placementSchema = z.object({
  area: shortId.nullish(),
  across: z.enum(PLACEMENT_ACROSS).nullish().catch(null),
  down: z.enum(PLACEMENT_DOWN).nullish().catch(null),
  size: z.enum(PLACEMENT_SIZES).nullish().catch(null),
});
export type Placement = z.infer<typeof placementSchema>;

export const planVariationSchema = z.object({
  title: clip(40).pipe(z.string().min(1)),
  summary: clip(200).optional().default(""),
  /** Only the parts this variation changes; the rest stay as they are. */
  parts: z
    .array(z.object({ regionId: shortId, color: hex, pattern: z.object({ id: shortId, color: hex }).nullish() }))
    .max(12)
    .nullish()
    .transform((v) => v ?? []),
  /** Only the style groups this variation changes. */
  styleOptions: z.partialRecord(z.enum(STYLE_GROUP_IDS), shortId.nullish()).nullish(),
  text: z.object({ content: clip(60), fontId: shortId, color: hex, placement: placementSchema.nullish() }).nullish(),
  /** One of the template's built-in decorations (preferred: no image service needed). */
  decoration: z.object({ id: shortId, color: hex, placement: placementSchema.nullish() }).nullish(),
  /** A drawn illustration, only when no built-in decoration fits. */
  motif: z.object({ prompt: clip(200).pipe(z.string().min(3)), color: hex, placement: placementSchema.nullish() }).nullish(),
  /** Earlier AI items to take off (otherwise they stay unless replaced). */
  remove: z.array(z.enum(["text", "decoration"]).catch("decoration")).max(2).nullish(),
});

export const planSchema = z.object({ variations: z.array(planVariationSchema).min(1).max(8) });

export type PlanVariation = z.infer<typeof planVariationSchema>;

// ─── template → planner vocabulary ───────────────────────────────────────────

export function planConstraints(template: TemplateConfig, dressName: string): PlanConstraints {
  return {
    dressName,
    garmentType: template.garmentType,
    regions: template.regions.filter((r) => r.recolorable).map((r) => ({ id: r.id, label: r.label })),
    colors: template.allowedColors.map((c) => ({ name: c.name, hex: c.hex.toLowerCase() })),
    patterns: [...template.allowedPatterns],
    fonts: [...template.allowedFonts],
    decorations: DECORATIONS.filter((d) => template.allowedDecorations.includes(d.id)).map((d) => ({ id: d.id, label: d.label })),
    areas: template.placementAreas.map((a) => ({ id: a.id, label: a.label, side: a.side, widthCm: a.widthCm, heightCm: a.heightCm })),
    styleOptions: Object.fromEntries(templateStyleGroups(template).map((g) => [g, styleOptionsFor(template, g).map((o) => ({ id: o.id, label: o.label }))])),
    layersAllowed: template.placementAreas.length > 0,
  };
}

export function summarizeSpec(spec: DesignSpec): PlanSummary {
  return {
    parts: Object.entries(spec.parts).map(([regionId, part]) => ({
      regionId,
      color: part.color,
      pattern: part.pattern ? { id: part.pattern.id, color: part.pattern.color } : null,
    })),
    styleOptions: { ...spec.styleOptions },
    items: spec.layers.map((layer) => ({
      kind: layer.kind === "image" && layer.id === `${AI_LAYER_PREFIX}motif` ? "motif" : layer.kind,
      what:
        layer.kind === "text" ? layer.text.content : layer.kind === "decoration" ? `${layer.decoration.id} in ${layer.decoration.color}` : "a picture",
      area: layer.areaId,
      byAi: layer.id.startsWith(AI_LAYER_PREFIX),
    })),
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

/** Default areas for AI items: decorations in the largest front area, text in another front area if there is one. */
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

/** Share of the area's shorter side a decoration takes, and of its width a line of text takes. */
const ORNAMENT_SIZE = { small: 0.22, medium: 0.4, large: 0.7 } as const;
const TEXT_WIDTH = { small: 0.35, medium: 0.6, large: 0.9 } as const;
/** Centre of each position as a fraction of the area, left to right as seen on the picture. */
const ACROSS_AT = [0.28, 0.5, 0.72] as const;
const DOWN_AT = { top: 0.25, middle: 0.5, bottom: 0.75 } as const;

/**
 * The layer box (area fractions) for a placement. Left and right are the wearer's: on the front the
 * wearer's left is on the picture's right; on the back it's on the left.
 */
export function placementBox(
  area: PlacementArea,
  placement: Placement | null | undefined,
  kind: "ornament" | "text",
  fallback: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  if (!placement || (!placement.across && !placement.down && !placement.size)) {
    return fallback;
  }
  const size = placement.size ?? "medium";
  let w: number;
  let h: number;
  if (kind === "ornament") {
    const sideCm = ORNAMENT_SIZE[size] * Math.min(area.widthCm, area.heightCm);
    w = sideCm / area.widthCm;
    h = sideCm / area.heightCm;
  } else {
    w = TEXT_WIDTH[size];
    h = Math.min(0.9, (w * area.widthCm * 0.3) / area.heightCm);
  }
  const across = placement.across ?? "centre";
  const index = across === "centre" ? 1 : (across === "wearer-left") === (area.side === "front") ? 2 : 0;
  const centreX = ACROSS_AT[index] ?? 0.5;
  const centreY = DOWN_AT[placement.down ?? "middle"];
  const clamp = (v: number, extent: number) => Math.min(Math.max(v, 0), 1 - extent);
  const r = (v: number) => Math.round(v * 10_000) / 10_000;
  return { x: r(clamp(centreX - w / 2, w)), y: r(clamp(centreY - h / 2, h)), w: r(w), h: r(h) };
}

/** A built-in decoration named in a motif's words ("small gold star" → star), if the template allows it. */
export function decorationInWords(words: string, template: TemplateConfig): DecorationId | null {
  const text = words.toLowerCase();
  return DECORATIONS.find((d) => template.allowedDecorations.includes(d.id) && new RegExp(`\\b${d.id}s?\\b`).test(text))?.id ?? null;
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
  for (const group of templateStyleGroups(template)) {
    const wanted = variation.styleOptions?.[group];
    if (wanted && styleOptionsFor(template, group).some((o) => o.id === wanted)) {
      styleOptions[group] = wanted;
    }
  }

  const aiLayers: DesignLayer[] = [];
  const slots = layerSlots(template);
  let newOrnament = false;
  let newText = false;
  if (slots) {
    const shared = slots.motif.id === slots.text.id;
    const areaFor = (placement: Placement | null | undefined, fallback: PlacementArea) =>
      template.placementAreas.find((a) => a.id === placement?.area) ?? fallback;
    const fontId = template.allowedFonts.find((f) => f === variation.text?.fontId) ?? template.allowedFonts[0];
    const color = variation.text ? nearestColor(variation.text.color, colors) : null;
    const content = variation.text?.content ?? "";
    const text = content && !findBrandTerm(content) && fontId && color ? { content, fontId, color } : null;

    // The ornament: a built-in decoration, else the drawn motif, else a built-in decoration the motif's
    // words name (when the picture couldn't be made).
    const motif = variation.motif && !findBrandTerm(variation.motif.prompt) ? variation.motif : null;
    const decorationId =
      (variation.decoration && template.allowedDecorations.find((d) => d === variation.decoration?.id)) ??
      (motif && !ctx.motifKey ? decorationInWords(motif.prompt, template) : null);
    const ornamentPlacement = variation.decoration?.placement ?? motif?.placement;
    const ornamentArea = areaFor(ornamentPlacement, slots.motif);
    const textArea = areaFor(variation.text?.placement, slots.text);
    const together = shared && ornamentArea.id === textArea.id && !ornamentPlacement && !variation.text?.placement;
    const ornamentBox = (wide: { x: number; y: number; w: number; h: number }) =>
      placementBox(ornamentArea, ornamentPlacement, "ornament", together && text ? { x: 0.15, y: 0.04, w: 0.7, h: 0.6 } : wide);
    const ornamentColor = nearestColor((variation.decoration ?? motif)?.color ?? "#000000", colors);
    if (decorationId && ornamentColor) {
      const box = ornamentBox({ x: 0.3, y: 0.3, w: 0.4, h: 0.4 });
      aiLayers.push({ id: `${AI_LAYER_PREFIX}decoration`, areaId: ornamentArea.id, kind: "decoration", rotation: 0, ...box, decoration: { id: decorationId, color: ornamentColor } });
      newOrnament = true;
    } else if (ctx.motifKey && motif) {
      const box = ornamentBox({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
      aiLayers.push({ id: `${AI_LAYER_PREFIX}motif`, areaId: ornamentArea.id, kind: "image", rotation: 0, ...box, image: { assetKey: ctx.motifKey } });
      newOrnament = true;
    }
    if (text) {
      const fallback = together && aiLayers.length > 0 ? { x: 0.05, y: 0.68, w: 0.9, h: 0.28 } : { x: 0.05, y: 0.25, w: 0.9, h: 0.5 };
      aiLayers.push({ id: `${AI_LAYER_PREFIX}text`, areaId: textArea.id, kind: "text", rotation: 0, ...placementBox(textArea, variation.text?.placement, "text", fallback), text });
      newText = true;
    }
  }

  // Earlier AI items stay unless this variation replaces or removes them; the customer's own stay.
  const removed = new Set(variation.remove ?? []);
  const isAiText = (l: DesignLayer) => l.id === `${AI_LAYER_PREFIX}text`;
  const kept = base.layers.filter((l) => {
    if (!l.id.startsWith(AI_LAYER_PREFIX)) return true;
    if (isAiText(l)) return !newText && !removed.has("text");
    return !newOrnament && !removed.has("decoration");
  });

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
