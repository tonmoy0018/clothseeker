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

/** An all-over print as drawn: the motif repeats every `tile` (a fraction of the picture's width). */
export type PrintFill =
  | { kind: "image"; assetKey: string; tile: number }
  | { kind: "decoration"; decorationId: DecorationId; color: string; tile: number };

export type RegionFill = {
  regionId: string;
  maskKey: string;
  color: string;
  pattern: { id: PatternId; color: string } | null;
  print: PrintFill | null;
};

/** A production file for an all-over print: one tile of the motif at its real size. */
export type PrintTile = { regionId: string; label: string; tileCm: number } & (
  | { kind: "image"; assetKey: string }
  | { kind: "decoration"; decorationId: DecorationId; color: string }
);

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
  /** Trim the layers to the garment's outline on this side (`fabricMaskKeys` of its side plan). */
  clipToFabric: boolean;
  /** Masks of the garment's outline on this side, for trimming (empty unless `clipToFabric`). */
  fabricMaskKeys: string[];
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
  /** How region colours go onto the garment picture (lib/design/shade.ts for "shade"). */
  recolor: TemplateConfig["recolor"];
  front: SidePlan;
  back: SidePlan;
  /** Areas that have at least one layer, i.e. the print files to produce. */
  printAreas: AreaPlan[];
  /** All-over prints, one production tile each. */
  printTiles: PrintTile[];
};

/**
 * How many cm the full width of a garment picture spans, from its placement areas (each knows its size
 * in cm and in fractions of the picture). 100 cm when the template has no areas.
 */
export function pictureWidthCm(template: Pick<TemplateConfig, "placementAreas">): number {
  const widths = template.placementAreas.map((a) => a.widthCm / a.rect.w).filter((w) => Number.isFinite(w) && w > 0);
  return widths.length > 0 ? Math.max(...widths) : 100;
}

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
  const widthCm = pictureWidthCm(template);
  const printFill = (print: DesignSpec["parts"][string]["print"]): PrintFill | null => {
    if (!print) return null;
    const tile = r4(print.tileCm / widthCm);
    return print.kind === "image" ? { kind: "image", assetKey: print.assetKey, tile } : { kind: "decoration", decorationId: print.id, color: print.color.toLowerCase(), tile };
  };
  // The garment's outline on each side, as drawn by the chosen style's picture: every region's mask.
  const fabricMasks = (side: Side) => {
    const picture = garmentPicture(template, side, spec.styleOptions);
    return template.regions.flatMap((region) => picture.maskFor(region.id) ?? []);
  };
  const outline = { front: fabricMasks("front"), back: fabricMasks("back") };
  const areaPlans: AreaPlan[] = template.placementAreas.map((area) => ({
    areaId: area.id,
    label: area.label,
    side: area.side,
    rect: { x: r4(area.rect.x), y: r4(area.rect.y), w: r4(area.rect.w), h: r4(area.rect.h) },
    widthCm: area.widthCm,
    heightCm: area.heightCm,
    clipToFabric: area.clipToFabric === true,
    fabricMaskKeys: area.clipToFabric === true ? outline[area.side] : [],
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
            print: printFill(part.print),
          },
        ];
      }),
      areas: areaPlans.filter((a) => a.side === side),
    };
  };

  const printTiles: PrintTile[] = template.regions.flatMap((region) => {
    const print = spec.parts[region.id]?.print;
    if (!print || !region.recolorable) return [];
    const base = { regionId: region.id, label: `${region.label} all-over print`, tileCm: r1(print.tileCm) };
    return [print.kind === "image" ? { ...base, kind: "image" as const, assetKey: print.assetKey } : { ...base, kind: "decoration" as const, decorationId: print.id, color: print.color.toLowerCase() }];
  });

  return {
    recolor: template.recolor,
    printTiles,
    front: sidePlan("front"),
    back: sidePlan("back"),
    printAreas: areaPlans.filter((a) => a.layers.length > 0),
  };
}
