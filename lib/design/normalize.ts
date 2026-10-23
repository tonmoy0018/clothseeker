import type { DecorationId } from "@/lib/catalog/decorations";
import type { FontId } from "@/lib/catalog/fonts";
import type { PatternId } from "@/lib/catalog/patterns";
import type { DesignSpec } from "@/types/design-spec";
import type { TemplateConfig } from "@/types/template";

import { garmentPicture } from "./garment-variant";

// DesignSpec + template → an explicit, ordered, rounded render plan.
// This is the ONLY input to the renderers: same plan ⇒ same pixels. Keeping it pure makes
// determinism and "what will be printed" testable without rendering anything.

export type Side = "front" | "back";

export type RegionFill = {
  regionId: string;
  maskKey: string;
  color: string;
  pattern: { id: PatternId; color: string } | null;
};

export type LayerOp = {
  id: string;
  /** Fractions of the area (top-left of the unrotated box), rounded to 1e-4. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees, rounded to 0.1. */
  rotation: number;
} & (
  | { kind: "text"; content: string; fontId: FontId; color: string }
  | { kind: "image"; assetKey: string }
  | { kind: "decoration"; decorationId: DecorationId; color: string }
);

export type AreaPlan = {
  areaId: string;
  label: string;
  side: Side;
  /** Area position on the garment image, fractions. */
  rect: { x: number; y: number; w: number; h: number };
  widthCm: number;
  heightCm: number;
  /** Bottom-to-top drawing order (array order of the spec). */
  layers: LayerOp[];
};

export type SidePlan = {
  side: Side;
  garmentKey: string | null;
  fills: RegionFill[];
  areas: AreaPlan[];
};

export type RenderPlan = {
  front: SidePlan;
  back: SidePlan;
  /** Areas that have at least one layer, i.e. the print files to produce. */
  printAreas: AreaPlan[];
};

const r4 = (v: number) => Math.round(v * 10_000) / 10_000;
const r1 = (v: number) => Math.round(v * 10) / 10;

function toOp(layer: DesignSpec["layers"][number]): LayerOp {
  const box = { id: layer.id, x: r4(layer.x), y: r4(layer.y), w: r4(layer.w), h: r4(layer.h), rotation: r1(layer.rotation) };
  switch (layer.kind) {
    case "text":
      return { ...box, kind: "text", content: layer.text.content, fontId: layer.text.fontId, color: layer.text.color.toLowerCase() };
    case "image":
      return { ...box, kind: "image", assetKey: layer.image.assetKey };
    case "decoration":
      return { ...box, kind: "decoration", decorationId: layer.decoration.id, color: layer.decoration.color.toLowerCase() };
  }
}

export function normalizeForRender(spec: DesignSpec, template: TemplateConfig): RenderPlan {
  const areaPlans: AreaPlan[] = template.placementAreas.map((area) => ({
    areaId: area.id,
    label: area.label,
    side: area.side,
    rect: { x: r4(area.rect.x), y: r4(area.rect.y), w: r4(area.rect.w), h: r4(area.rect.h) },
    widthCm: area.widthCm,
    heightCm: area.heightCm,
    layers: spec.layers.filter((l) => l.areaId === area.id).map(toOp),
  }));

  const sidePlan = (side: Side): SidePlan => {
    // The picture for the chosen neckline/sleeve/length, if the template has one.
    const picture = garmentPicture(template, side, spec.styleOptions);
    return {
      side,
      garmentKey: picture.garmentKey,
      // Template region order is the paint order, independent of how the spec's object was built.
      fills: template.regions.flatMap((region) => {
        const part = spec.parts[region.id];
        const maskKey = picture.maskFor(region.id);
        if (!part || !maskKey || !region.recolorable) {
          return [];
        }
        return [
          {
            regionId: region.id,
            maskKey,
            color: part.color.toLowerCase(),
            pattern: part.pattern ? { id: part.pattern.id, color: part.pattern.color.toLowerCase() } : null,
          },
        ];
      }),
      areas: areaPlans.filter((a) => a.side === side),
    };
  };

  return {
    front: sidePlan("front"),
    back: sidePlan("back"),
    printAreas: areaPlans.filter((a) => a.layers.length > 0),
  };
}
