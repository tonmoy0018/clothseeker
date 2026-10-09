import { DECORATIONS } from "@/lib/catalog/decorations";
import { FONTS } from "@/lib/catalog/fonts";
import { PATTERNS } from "@/lib/catalog/patterns";
import type { PrismaClient } from "@/lib/db/client";
import type { StorageAdapter } from "@/lib/storage/adapter";
import { BUCKETS } from "@/lib/storage/buckets";
import { designSpecSchema } from "@/types/design-spec";
import { parseTemplateConfig, STYLE_GROUPS, type TemplateConfig } from "@/types/template";

import type { SpecSheetData } from "./pdf/spec-sheet";
import type { AdminOrder } from "./queries";

const GROUP_LABEL = { neckline: "Neckline", sleeveLength: "Sleeves", dressLength: "Length" } as const;

/** Readable "Emerald (#1f6f50)" for a hex, using the template's colour names when available. */
function colourName(hex: string, template: TemplateConfig | null): string {
  const named = template?.allowedColors.find((c) => c.hex.toLowerCase() === hex.toLowerCase());
  return named ? `${named.name} (${hex})` : hex;
}

/**
 * Everything printed on one item's spec sheet. Uses the frozen DesignSpec and print files;
 * the template is only consulted for human-readable labels.
 */
export async function specSheetData(
  db: PrismaClient,
  storage: StorageAdapter,
  order: AdminOrder,
  item: AdminOrder["items"][number],
  adminUrl: string,
): Promise<SpecSheetData> {
  const base: SpecSheetData = {
    orderNumber: order.number,
    itemId: item.id,
    paidAt: order.paidAt,
    kind: item.kind,
    productName: item.productName,
    size: item.size,
    quantity: item.quantity,
    colorName: item.colorName,
    parts: [],
    styleOptions: [],
    layers: [],
    printFiles: item.printFiles,
    previewPng: item.previewKey ? await storage.get(BUCKETS.designAssets, item.previewKey) : null,
    referencePng: null,
    customerNote: order.customerNote,
    adminUrl,
  };

  const spec = designSpecSchema.safeParse(item.designSpec);
  if (!spec.success) {
    return base;
  }
  const productId = item.design?.productId ?? spec.data.productId;
  const row = await db.customizationTemplate.findUnique({ where: { productId }, select: { config: true } });
  let template: TemplateConfig | null = null;
  try {
    template = row ? parseTemplateConfig(row.config) : null;
  } catch {
    template = null;
  }

  const regionLabel = (id: string) => template?.regions.find((r) => r.id === id)?.label ?? id;
  const areaLabel = (id: string) => template?.placementAreas.find((a) => a.id === id)?.label ?? id;

  return {
    ...base,
    parts: Object.entries(spec.data.parts).map(([regionId, part]) => ({
      region: regionLabel(regionId),
      color: colourName(part.color, template),
      pattern: part.pattern
        ? `${PATTERNS.find((p) => p.id === part.pattern?.id)?.label ?? part.pattern.id} in ${colourName(part.pattern.color, template)}`
        : null,
    })),
    styleOptions: STYLE_GROUPS.map((group) => ({
      group: GROUP_LABEL[group],
      option: template?.styleOptions[group].find((o) => o.id === spec.data.styleOptions[group])?.label ?? spec.data.styleOptions[group],
    })),
    layers: spec.data.layers.map((layer) => ({
      area: areaLabel(layer.areaId),
      description:
        layer.kind === "text"
          ? `Text "${layer.text.content}" - ${FONTS.find((f) => f.id === layer.text.fontId)?.label ?? layer.text.fontId}, ${colourName(layer.text.color, template)}`
          : layer.kind === "decoration"
            ? `${DECORATIONS.find((d) => d.id === layer.decoration.id)?.label ?? layer.decoration.id} decoration, ${colourName(layer.decoration.color, template)}`
            : "Customer image (see print file)",
    })),
  };
}
