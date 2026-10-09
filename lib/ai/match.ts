import { z } from "zod";

import type { DesignContext } from "@/lib/design/validate";
import type { DesignSpec } from "@/types/design-spec";
import { STYLE_GROUPS, type StyleGroup, type TemplateConfig } from "@/types/template";

import { variationToSpec, type PlanVariation } from "./plan";
import type { DressCandidate } from "./types";

// "Start from a dress photo / description": the planner picks the closest live customizable dress
// and its main colors. Its answer is untrusted: it must name one of the candidates we offered, and
// colors/pattern/style are fitted to that dress's template by the same rules as an AI design round.

const hex = z
  .string()
  .trim()
  .regex(/^#?[0-9a-f]{6}$/i)
  .transform((v) => `#${v.replace("#", "").toLowerCase()}`);
const word = z.string().trim().max(40);

export const dressMatchSchema = z.object({
  productId: z.uuid(),
  alternatives: z.array(z.uuid()).max(5).optional().default([]),
  primaryColor: hex.nullish(),
  secondaryColor: hex.nullish(),
  pattern: word.nullish(),
  styleOptions: z.object({ neckline: word.nullish(), sleeveLength: word.nullish(), dressLength: word.nullish() }).partial().nullish(),
});

export type DressMatch = z.infer<typeof dressMatchSchema> & { alternatives: string[] };

export class DressMatchError extends Error {
  override readonly name = "DressMatchError";
}

/** Parses the planner's answer; the chosen dress must be one of the candidates. Up to 2 alternatives. */
export function parseDressMatch(raw: unknown, candidates: readonly DressCandidate[]): DressMatch {
  const parsed = dressMatchSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DressMatchError("The planner's answer isn't a dress match");
  }
  const ids = new Set(candidates.map((c) => c.productId));
  if (!ids.has(parsed.data.productId)) {
    throw new DressMatchError("The planner chose a dress we didn't offer");
  }
  const alternatives = [...new Set(parsed.data.alternatives)].filter((id) => ids.has(id) && id !== parsed.data.productId).slice(0, 2);
  return { ...parsed.data, alternatives };
}

/** The region that carries a pattern: the skirt if there is one, else the first recolorable region. */
function mainRegion(template: TemplateConfig): string | null {
  const recolorable = template.regions.filter((r) => r.recolorable);
  return (recolorable.find((r) => r.id === "skirt") ?? recolorable[0])?.id ?? null;
}

/** Matches a style word to an option by id or label, ignoring case ("V-neck" → "v-neck"). */
function styleOption(template: TemplateConfig, group: StyleGroup, wanted: string | null | undefined): string | null {
  if (!wanted) return null;
  const w = wanted.toLowerCase().replace(/[\s_]+/g, "-");
  return template.styleOptions[group].find((o) => o.id === w || o.label.toLowerCase().replace(/\s+/g, "-") === w)?.id ?? null;
}

/** A fresh design for the matched dress (first available size, first options), before fitting. */
export function startingSpec(
  template: { productId: string; templateId: string; version: number; config: TemplateConfig },
  size: DesignSpec["size"],
  startedFrom: "photo" | "description",
  referencePhotoKey: string | null,
): DesignSpec {
  const first = (group: StyleGroup) => template.config.styleOptions[group][0]?.id ?? "";
  return {
    version: 1,
    productId: template.productId,
    templateId: template.templateId,
    templateVersion: template.version,
    size,
    styleOptions: { neckline: first("neckline"), sleeveLength: first("sleeveLength"), dressLength: first("dressLength") },
    parts: {},
    layers: [],
    startedFrom,
    ...(referencePhotoKey ? { referencePhotoKey } : {}),
  };
}

/** Applies the match's colors, pattern and style to the starting design; the result is template-valid. */
export function matchToSpec(base: DesignSpec, match: DressMatch, ctx: DesignContext & { template: TemplateConfig }): DesignSpec {
  const { template } = ctx;
  const main = mainRegion(template);
  const parts: PlanVariation["parts"] = [];
  if (match.primaryColor) {
    for (const region of template.regions.filter((r) => r.recolorable)) {
      const isMain = region.id === main;
      parts.push({
        regionId: region.id,
        color: isMain ? match.primaryColor : (match.secondaryColor ?? match.primaryColor),
        pattern: isMain && match.pattern ? { id: match.pattern.toLowerCase().replace(/\s+/g, "-"), color: match.secondaryColor ?? "#f5f5f0" } : null,
      });
    }
  }
  const styleOptions = Object.fromEntries(STYLE_GROUPS.map((g) => [g, styleOption(template, g, match.styleOptions?.[g])]));
  const variation: PlanVariation = { title: "Your match", summary: "", parts, styleOptions, text: null, motif: null };
  // variationToSpec only falls back to fewer AI layers; with no layers it returns null only if the
  // base itself is invalid, which startingSpec never is.
  return variationToSpec(base, variation, { ...ctx, motifKey: null }) ?? base;
}
