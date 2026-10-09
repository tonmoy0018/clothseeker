import type { Size } from "@/lib/generated/prisma/enums";
import { MAX_LAYERS_PER_AREA, type DesignLayer, type DesignSpec } from "@/types/design-spec";
import { STYLE_GROUPS, type PlacementArea, type TemplateConfig } from "@/types/template";

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

/** Whether an image layer's file is the customer's own upload or AI motif. */
export function isCustomerImageKey(key: string, customerId: string): boolean {
  return key.startsWith(customerUploadPrefix(customerId)) || key.startsWith(customerAiPrefix(customerId));
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

  if (spec.productId !== ctx.productId) {
    add("productId", "This design belongs to a different dress.");
  }
  if (spec.templateId !== ctx.templateId) {
    add("templateId", "This design was made for a different template.");
  }
  if (spec.referencePhotoKey && (!ctx.customerId || !spec.referencePhotoKey.startsWith(customerReferencePrefix(ctx.customerId)))) {
    add("referencePhotoKey", "That reference photo isn't yours.");
  }
  if (!ctx.availableSizes.includes(spec.size)) {
    add("size", `Size ${spec.size} isn't available for this dress.`);
  }

  for (const group of STYLE_GROUPS) {
    if (!template.styleOptions[group].some((o) => o.id === spec.styleOptions[group])) {
      add(`styleOptions.${group}`, "That style option is no longer available.");
    }
  }

  const allowedColors = new Set(template.allowedColors.map((c) => c.hex.toLowerCase()));
  const recolorable = new Map(template.regions.filter((r) => r.recolorable).map((r) => [r.id, r]));
  for (const [regionId, part] of Object.entries(spec.parts)) {
    const path = `parts.${regionId}`;
    if (!recolorable.has(regionId)) {
      add(path, "That part of the dress can't be recolored.");
      continue;
    }
    if (!allowedColors.has(part.color)) {
      add(`${path}.color`, "That color isn't available for this dress.");
    }
    if (part.pattern) {
      if (!template.allowedPatterns.includes(part.pattern.id)) {
        add(`${path}.pattern`, "That pattern isn't available for this dress.");
      }
      if (!allowedColors.has(part.pattern.color)) {
        add(`${path}.pattern.color`, "That pattern color isn't available for this dress.");
      }
    }
  }

  const areas = new Map(template.placementAreas.map((a) => [a.id, a]));
  const perArea = new Map<string, number>();
  const seenIds = new Set<string>();
  spec.layers.forEach((layer, index) => {
    const path = `layers.${index}`;
    if (seenIds.has(layer.id)) {
      add(path, "Duplicate layer.");
    }
    seenIds.add(layer.id);

    const area = areas.get(layer.areaId);
    if (!area) {
      add(`${path}.areaId`, "That placement area doesn't exist on this dress.");
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
          add(`${path}.text.fontId`, "That font isn't available for this dress.");
        }
        if (!allowedColors.has(layer.text.color)) {
          add(`${path}.text.color`, "That text color isn't available for this dress.");
        }
        break;
      case "decoration":
        if (!template.allowedDecorations.includes(layer.decoration.id)) {
          add(`${path}.decoration.id`, "That decoration isn't available for this dress.");
        }
        if (!allowedColors.has(layer.decoration.color)) {
          add(`${path}.decoration.color`, "That decoration color isn't available for this dress.");
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
