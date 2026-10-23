import { DEFAULT_TEMPLATE_CONFIG } from "@/lib/catalog/default-template";
import type { DesignContext } from "@/lib/design/validate";
import { MemoryStorageAdapter } from "@/lib/storage/memory";
import { BUCKETS } from "@/lib/storage/buckets";
import { renderGarment, renderMask, type GarmentStyle } from "@/prisma/seed-garments";
import type { DesignSpec } from "@/types/design-spec";
import { templateConfigSchema, type TemplateConfig } from "@/types/template";

export const PRODUCT_ID = "3f2b8a52-6c1e-4b7a-9d0f-1a2b3c4d5e6f";
export const TEMPLATE_ID = "4a3b2c1d-1111-4222-8333-444455556666";
export const CUSTOMER_ID = "5b6c7d8e-2222-4333-8444-555566667777";

const key = (category: string, name: string, ext: "webp" | "png") =>
  `${PRODUCT_ID}/${category}/${name.padEnd(8, "0")}-1111-4111-8111-111111111111.${ext}`;

export const KEYS = {
  front: key("template", "aaaaaaaa", "webp"),
  back: key("template", "bbbbbbbb", "webp"),
  strapsFront: key("template", "cccccccc", "png"),
  bodiceFront: key("template", "dddddddd", "png"),
  skirtFront: key("template", "eeeeeeee", "png"),
  skirtBack: key("template", "ffffffff", "png"),
  upload: `${CUSTOMER_ID}/uploads/12345678-1111-4111-8111-111111111111.webp`,
};

export const TEMPLATE: TemplateConfig = templateConfigSchema.parse({
  ...DEFAULT_TEMPLATE_CONFIG,
  garmentImages: { front: KEYS.front, back: KEYS.back },
  regions: [
    { id: "straps", label: "Straps", recolorable: true, masks: { front: KEYS.strapsFront } },
    { id: "bodice", label: "Bodice", recolorable: true, masks: { front: KEYS.bodiceFront } },
    { id: "skirt", label: "Skirt", recolorable: true, masks: { front: KEYS.skirtFront, back: KEYS.skirtBack } },
    { id: "lining", label: "Lining", recolorable: false, masks: {} },
  ],
});

/** A valid design: emerald skirt with polka dots, text + decoration on the chest, square neckline. */
export function validSpec(overrides: Partial<DesignSpec> = {}): DesignSpec {
  return {
    version: 1,
    productId: PRODUCT_ID,
    templateId: TEMPLATE_ID,
    templateVersion: 3,
    size: "M",
    styleOptions: { neckline: "square", sleeveLength: "short", dressLength: "midi" },
    parts: {
      skirt: { color: "#1f6f50", pattern: { id: "polka-dots", color: "#f5f5f0" } },
      bodice: { color: "#1f6f50" },
    },
    layers: [
      {
        id: "t1",
        areaId: "front-chest",
        kind: "text",
        x: 0.05,
        y: 0.1,
        w: 0.9,
        h: 0.4,
        rotation: 0,
        text: { content: "Ava 2026", fontId: "dancing-script", color: "#f5f5f0" },
      },
      {
        id: "d1",
        areaId: "front-chest",
        kind: "decoration",
        x: 0.35,
        y: 0.55,
        w: 0.3,
        h: 0.4,
        rotation: 0,
        decoration: { id: "heart", color: "#e8a0b4" },
      },
    ],
    startedFrom: "shop",
    ...overrides,
  };
}

export const CONTEXT: DesignContext = {
  productId: PRODUCT_ID,
  templateId: TEMPLATE_ID,
  availableSizes: ["S", "M", "L"],
  customerId: CUSTOMER_ID,
};

/** The style drawn on TEMPLATE's garment images (the same as validSpec's style options). */
export const FIXTURE_STYLE: GarmentStyle = { neckline: "square", sleeveLength: "short", dressLength: "midi" };

/** In-memory storage holding the garment images and masks used by TEMPLATE. */
export async function storageWithTemplateAssets(): Promise<MemoryStorageAdapter> {
  const storage = new MemoryStorageAdapter();
  await storage.put(BUCKETS.productMedia, KEYS.front, await renderGarment("front", FIXTURE_STYLE), "image/webp");
  await storage.put(BUCKETS.productMedia, KEYS.back, await renderGarment("back", FIXTURE_STYLE), "image/webp");
  await storage.put(BUCKETS.productMedia, KEYS.strapsFront, await renderMask("front", FIXTURE_STYLE, "straps"), "image/png");
  await storage.put(BUCKETS.productMedia, KEYS.bodiceFront, await renderMask("front", FIXTURE_STYLE, "bodice"), "image/png");
  await storage.put(BUCKETS.productMedia, KEYS.skirtFront, await renderMask("front", FIXTURE_STYLE, "skirt"), "image/png");
  await storage.put(BUCKETS.productMedia, KEYS.skirtBack, await renderMask("back", FIXTURE_STYLE, "skirt"), "image/png");
  return storage;
}
