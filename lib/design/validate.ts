import { hasDetail, motifCount } from "@/lib/catalog/decorations";
import { GARMENT_TYPES } from "@/lib/catalog/garment-types";
import type { Size } from "@/lib/generated/prisma/enums";
import { MAX_LAYERS_PER_AREA, MAX_MOTIFS_TOTAL, type DesignLayer, type DesignSpec } from "@/types/design-spec";
import { styleOptionsFor, templateStyleGroups, type PlacementArea, type TemplateConfig } from "@/types/template";

// Business rules a DesignSpec must satisfy against the CURRENT template. Pure, so the browser can
// show the same messages, but only the server's result counts.

export type DesignIssue = { path: string; message: string };

export type DesignContext = {
  productId: string;
  templateId: string;
  /** Sizes the product is sold in (active variants). */
  availableSizes: readonly Size[];
  /** The design's owner; image layers must reference this customer's own uploads or AI motifs. */
  customerId: string | null;
};

/** Tolerance for floating-point edges, in centimetres. */
const EDGE_TOLERANCE_CM = 0.05;

/** Customer uploads live under `{customerId}/uploads/` in the design-assets bucket. */
export function customerUploadPrefix(customerId: string): string {
  return `${customerId.toLowerCase()}/uploads/`;
}

/** Motifs made for the customer by the AI design box live under `{customerId}/ai/`. */
export function customerAiPrefix(customerId: string): string {
  return `${customerId.toLowerCase()}/ai/`;
}

/** Dress photos a design was started from live under `{customerId}/references/`. */
export function customerReferencePrefix(customerId: string): string {
  return `${customerId.toLowerCase()}/references/`;
}

/** Decorations the customer cut out of ClothSeeker dresses live under `{customerId}/cutouts/`. */
export function customerCutoutPrefix(customerId: string): string {
  return `${customerId.toLowerCase()}/cutouts/`;
}

/** Whether an image layer's file is the customer's own upload, AI motif or cut-out. */
export function isCustomerImageKey(key: string, customerId: string): boolean {
  return key.startsWith(customerUploadPrefix(customerId)) || key.startsWith(customerAiPrefix(customerId)) || key.startsWith(customerCutoutPrefix(customerId));
}

/** Whether an image file is a cut-out decoration (priced and made like a decoration). Keys are owner-checked separately. */
export function isCutoutKey(key: string): boolean {
  return /^[0-9a-f-]{36}\/cutouts\//.test(key);
}

/** Motifs a layer prints: a border counts each repeat; text is not a motif. */
export function layerMotifs(layer: DesignLayer): number {
  return layer.kind === "decoration" ? motifCount(layer.decoration.repeat) : layer.kind === "image" ? motifCount(layer.image.repeat) : 0;
}

/**
 * Whether a (possibly rotated) layer stays inside its placement area.
 * Computed in centimetres so rotation respects the area's real aspect ratio.
 */
export function layerFitsArea(layer: Pick<DesignLayer, "x" | "y" | "w" | "h" | "rotation">, area: PlacementArea): boolean {
  const W = area.widthCm;
  const H = area.heightCm;
  const halfW = (layer.w * W) / 2;
  const halfH = (layer.h * H) / 2;
  const centreX = layer.x * W + halfW;
  const centreY = layer.y * H + halfH;
  const radians = (layer.rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const extentX = halfW * cos + halfH * sin;
  const extentY = halfW * sin + halfH * cos;
  return (
    centreX - extentX >= -EDGE_TOLERANCE_CM &&
    centreY - extentY >= -EDGE_TOLERANCE_CM &&
    centreX + extentX <= W + EDGE_TOLERANCE_CM &&
    centreY + extentY <= H + EDGE_TOLERANCE_CM
  );
}

export function validateDesignAgainstTemplate(spec: DesignSpec, template: TemplateConfig, ctx: DesignContext): DesignIssue[] {
  const issues: DesignIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  const noun = GARMENT_TYPES[template.garmentType].noun;

  if (spec.productId !== ctx.productId) {
    add("productId", `This design belongs to a different ${noun}.`);
  }
  if (spec.templateId !== ctx.templateId) {
    add("templateId", "This design was made for a different template.");
  }
  if (spec.referencePhotoKey && (!ctx.customerId || !spec.referencePhotoKey.startsWith(customerReferencePrefix(ctx.customerId)))) {
    add("referencePhotoKey", "That reference photo isn't yours.");
  }
  if (!ctx.availableSizes.includes(spec.size)) {
    add("size", `Size ${spec.size} isn't available for this ${noun}.`);
  }

  const groups = templateStyleGroups(template);
  for (const group of groups) {
    if (!styleOptionsFor(template, group).some((o) => o.id === spec.styleOptions[group])) {
      add(`styleOptions.${group}`, "That style option is no longer available.");
    }
  }
  for (const group of Object.keys(spec.styleOptions)) {
    if (!groups.some((g) => g === group)) {
      add(`styleOptions.${group}`, `A ${noun} has no ${group} option.`);
    }
  }

  const allowedColors = new Set(template.allowedColors.map((c) => c.hex.toLowerCase()));
  const recolorable = new Map(template.regions.filter((r) => r.recolorable).map((r) => [r.id, r]));
  for (const [regionId, part] of Object.entries(spec.parts)) {
    const path = `parts.${regionId}`;
    if (!recolorable.has(regionId)) {
      add(path, `That part of the ${noun} can't be recolored.`);
      continue;
    }
    if (!allowedColors.has(part.color)) {
      add(`${path}.color`, `That color isn't available for this ${noun}.`);
    }
    if (part.pattern) {
      if (!template.allowedPatterns.includes(part.pattern.id)) {
        add(`${path}.pattern`, `That pattern isn't available for this ${noun}.`);
      }
      if (!allowedColors.has(part.pattern.color)) {
        add(`${path}.pattern.color`, `That pattern color isn't available for this ${noun}.`);
      }
    }
    if (part.print?.kind === "decoration") {
      if (!template.allowedDecorations.includes(part.print.id)) {
        add(`${path}.print.id`, `That decoration isn't available for this ${noun}.`);
      }
      if (!allowedColors.has(part.print.color)) {
        add(`${path}.print.color`, `That print color isn't available for this ${noun}.`);
      }
    } else if (part.print?.kind === "image") {
      if (!ctx.customerId) {
        add(`${path}.print`, "Sign in to use your own images.");
      } else if (!isCustomerImageKey(part.print.assetKey, ctx.customerId)) {
        add(`${path}.print`, "That image isn't one of your uploads.");
      }
    }
  }

  const areas = new Map(template.placementAreas.map((a) => [a.id, a]));
  const perArea = new Map<string, number>();
  const motifs = spec.layers.reduce((sum, l) => sum + layerMotifs(l), 0);
  if (motifs > MAX_MOTIFS_TOTAL) {
    add("layers", `A design can have at most ${MAX_MOTIFS_TOTAL} decorations and images (borders count each one).`);
  }
  const seenIds = new Set<string>();
  spec.layers.forEach((layer, index) => {
    const path = `layers.${index}`;
    if (seenIds.has(layer.id)) {
      add(path, "Duplicate layer.");
    }
    seenIds.add(layer.id);

    const area = areas.get(layer.areaId);
    if (!area) {
      add(`${path}.areaId`, `That placement area doesn't exist on this ${noun}.`);
      return;
    }
    const count = (perArea.get(area.id) ?? 0) + 1;
    perArea.set(area.id, count);
    if (count === MAX_LAYERS_PER_AREA + 1) {
      add(`${path}.areaId`, `“${area.label}” can hold at most ${MAX_LAYERS_PER_AREA} items.`);
    }
    if (!layerFitsArea(layer, area)) {
      add(path, `An item sticks out of “${area.label}”. Move or shrink it so it fits inside the area.`);
    }

    switch (layer.kind) {
      case "text":
        if (!template.allowedFonts.includes(layer.text.fontId)) {
          add(`${path}.text.fontId`, `That font isn't available for this ${noun}.`);
        }
        if (!allowedColors.has(layer.text.color)) {
          add(`${path}.text.color`, `That text color isn't available for this ${noun}.`);
        }
        break;
      case "decoration":
        if (!template.allowedDecorations.includes(layer.decoration.id)) {
          add(`${path}.decoration.id`, `That decoration isn't available for this ${noun}.`);
        }
        if (!allowedColors.has(layer.decoration.color)) {
          add(`${path}.decoration.color`, `That decoration color isn't available for this ${noun}.`);
        }
        if (layer.decoration.detail !== undefined) {
          if (!hasDetail(layer.decoration.id)) {
            add(`${path}.decoration.detail`, "This decoration has no second color.");
          } else if (!allowedColors.has(layer.decoration.detail)) {
            add(`${path}.decoration.detail`, `That decoration color isn't available for this ${noun}.`);
          }
        }
        break;
      case "image":
        if (!ctx.customerId) {
          add(`${path}.image`, "Sign in to use your own images.");
        } else if (!isCustomerImageKey(layer.image.assetKey, ctx.customerId)) {
          add(`${path}.image`, "That image isn't one of your uploads.");
        }
        break;
    }
  });

  return issues;
}
