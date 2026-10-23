import { z } from "zod";

import { assertAdmin, type Actor } from "@/lib/auth/policy";
import { DEFAULT_TEMPLATE_CONFIG } from "@/lib/catalog/default-template";
import type { PrismaClient } from "@/lib/db/client";
import type { StorageAdapter } from "@/lib/storage/adapter";
import { BUCKETS } from "@/lib/storage/buckets";
import {
  parseTemplateConfig,
  STYLE_GROUPS,
  templateConfigSchema,
  templateImageKeys,
  type TemplateConfig,
} from "@/types/template";

import { writeAudit } from "./audit";
import { AdminError } from "./errors";
import { storeProductImage } from "./media";

// Customization templates. The config is versioned JSON (types/template.ts); every save bumps
// `version` and uses optimistic locking so two admins can't silently overwrite each other.

const productIdSchema = z.uuid();

export type TemplateForEdit = {
  productId: string;
  productName: string;
  version: number;
  isActive: boolean;
  aiEnabled: boolean;
  config: TemplateConfig;
  /** Signed URLs for every image the config references. */
  imageUrls: Record<string, string>;
};

export async function createTemplate(db: PrismaClient, actor: Actor, rawProductId: unknown): Promise<void> {
  assertAdmin(actor);
  const productId = productIdSchema.parse(rawProductId);
  const product = await db.product.findUnique({ where: { id: productId }, select: { template: { select: { id: true } } } });
  if (!product) {
    throw new AdminError("NOT_FOUND", "That dress no longer exists.");
  }
  if (product.template) {
    return;
  }
  await db.$transaction(async (tx) => {
    const template = await tx.customizationTemplate.create({
      data: { productId, version: 1, config: DEFAULT_TEMPLATE_CONFIG, isActive: false, aiEnabled: false },
      select: { id: true },
    });
    await writeAudit(tx, actor, "template.create", { type: "template", id: template.id }, { productId });
  });
}

export async function getTemplateForEdit(
  db: PrismaClient,
  storage: StorageAdapter,
  actor: Actor,
  rawProductId: unknown,
): Promise<TemplateForEdit | null> {
  assertAdmin(actor);
  const parsed = productIdSchema.safeParse(rawProductId);
  if (!parsed.success) {
    return null;
  }
  const product = await db.product.findUnique({
    where: { id: parsed.data },
    select: { id: true, name: true, template: { select: { version: true, isActive: true, aiEnabled: true, config: true } } },
  });
  if (!product?.template) {
    return null;
  }
  const config = parseTemplateConfig(product.template.config);
  const urls = await storage.signReadUrls(BUCKETS.productMedia, templateImageKeys(config));
  return {
    productId: product.id,
    productName: product.name,
    version: product.template.version,
    isActive: product.template.isActive,
    aiEnabled: product.template.aiEnabled,
    config,
    imageUrls: Object.fromEntries(urls),
  };
}

/** Rules a template must satisfy before customers can use it. Returns human-readable problems. */
export function activationProblems(config: TemplateConfig): string[] {
  const problems: string[] = [];
  if (!config.garmentImages.front) {
    problems.push("Upload a front garment image.");
  }
  if (config.placementAreas.some((a) => a.side === "back") && !config.garmentImages.back) {
    problems.push("Upload a back garment image, or remove the back placement areas.");
  }
  if (!config.regions.some((r) => r.recolorable)) {
    problems.push("Make at least one region recolorable.");
  }
  // A region may appear only on some style pictures (e.g. sleeves, when the main photo is sleeveless).
  const unmasked = config.regions.filter((r) => r.recolorable && !r.masks.front && !r.masks.back && !config.styleVariants.some((v) => v.masks[r.id]));
  if (unmasked.length > 0) {
    problems.push(`Upload a mask for: ${unmasked.map((r) => r.label).join(", ")}.`);
  }
  if (config.allowedFonts.length === 0 && config.placementAreas.length > 0) {
    problems.push("Allow at least one font for text in the placement areas.");
  }
  return problems;
}

/** Image keys must live under this product's own storage prefix. */
function assertKeysBelongToProduct(config: TemplateConfig, productId: string): void {
  const foreign = templateImageKeys(config).filter((key) => !key.startsWith(`${productId}/`));
  if (foreign.length > 0) {
    throw new AdminError("INVALID", "The template references an image that doesn't belong to this dress.");
  }
}

export const saveTemplateSchema = z.object({
  productId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  config: templateConfigSchema,
});

export async function saveTemplate(
  db: PrismaClient,
  storage: StorageAdapter,
  actor: Actor,
  rawInput: unknown,
): Promise<{ version: number }> {
  assertAdmin(actor);
  const input = saveTemplateSchema.parse(rawInput);
  assertKeysBelongToProduct(input.config, input.productId);

  const current = await db.customizationTemplate.findUnique({
    where: { productId: input.productId },
    select: { id: true, version: true, isActive: true, config: true },
  });
  if (!current) {
    throw new AdminError("NOT_FOUND", "This dress has no template yet.");
  }
  if (current.isActive) {
    const problems = activationProblems(input.config);
    if (problems.length > 0) {
      throw new AdminError("BLOCKED", `This template is live, so it must stay complete: ${problems.join(" ")}`);
    }
  }

  const nextVersion = input.expectedVersion + 1;
  await db.$transaction(async (tx) => {
    const updated = await tx.customizationTemplate.updateMany({
      where: { id: current.id, version: input.expectedVersion },
      data: { config: input.config, version: nextVersion },
    });
    if (updated.count !== 1) {
      throw new AdminError("CONFLICT", "Someone else saved this template meanwhile. Reload the page to see their changes.");
    }
    await writeAudit(tx, actor, "template.update", { type: "template", id: current.id }, {
      productId: input.productId,
      fromVersion: input.expectedVersion,
      toVersion: nextVersion,
    });
  });

  // Images dropped from the config are no longer referenced anywhere: delete them.
  const kept = new Set(templateImageKeys(input.config));
  let previous: TemplateConfig | null = null;
  try {
    previous = parseTemplateConfig(current.config);
  } catch {
    previous = null;
  }
  const dropped = previous ? templateImageKeys(previous).filter((key) => !kept.has(key)) : [];
  if (dropped.length > 0) {
    await storage.remove(BUCKETS.productMedia, dropped).catch(() => undefined);
  }
  return { version: nextVersion };
}

export const setTemplateStateSchema = z.object({
  productId: z.uuid(),
  isActive: z.boolean(),
  aiEnabled: z.boolean(),
});

export async function setTemplateState(db: PrismaClient, actor: Actor, rawInput: unknown): Promise<void> {
  assertAdmin(actor);
  const input = setTemplateStateSchema.parse(rawInput);
  const template = await db.customizationTemplate.findUnique({
    where: { productId: input.productId },
    select: { id: true, isActive: true, aiEnabled: true, config: true },
  });
  if (!template) {
    throw new AdminError("NOT_FOUND", "This dress has no template yet.");
  }
  if (input.isActive && !template.isActive) {
    const problems = activationProblems(parseTemplateConfig(template.config));
    if (problems.length > 0) {
      throw new AdminError("BLOCKED", problems.join(" "));
    }
  }
  if (input.isActive === template.isActive && input.aiEnabled === template.aiEnabled) {
    return;
  }
  await db.$transaction(async (tx) => {
    await tx.customizationTemplate.update({
      where: { id: template.id },
      data: { isActive: input.isActive, aiEnabled: input.aiEnabled },
    });
    await writeAudit(tx, actor, "template.state", { type: "template", id: template.id }, {
      productId: input.productId,
      isActive: input.isActive,
      aiEnabled: input.aiEnabled,
    });
  });
}

const slotSchema = z.union([
  z.enum(["front", "back"]),
  z.string().regex(new RegExp(`^style:(${STYLE_GROUPS.join("|")}):[a-z0-9][a-z0-9-]{0,39}$`)),
  z.string().regex(/^mask:(front|back):[a-z0-9][a-z0-9-]{0,39}$/),
]);

/**
 * Stores a garment or style-reference image and returns its key + a signed preview URL.
 * The key only becomes part of the template when the editor saves it.
 */
export async function uploadTemplateImage(
  db: PrismaClient,
  storage: StorageAdapter,
  actor: Actor,
  rawInput: { productId: unknown; slot: unknown },
  bytes: Uint8Array,
): Promise<{ key: string; url: string | null }> {
  assertAdmin(actor);
  const productId = productIdSchema.parse(rawInput.productId);
  const slot = slotSchema.parse(rawInput.slot);
  const template = await db.customizationTemplate.count({ where: { productId } });
  if (template === 0) {
    throw new AdminError("NOT_FOUND", "This dress has no template yet.");
  }
  const isGarment = slot === "front" || slot === "back";
  const isMask = slot.startsWith("mask:");
  const key = await storeProductImage(
    storage,
    productId,
    bytes,
    isGarment ? "garment" : isMask ? "mask" : "styleReference",
    isGarment || isMask ? "template" : "style",
  );
  const urls = await storage.signReadUrls(BUCKETS.productMedia, [key]);
  return { key, url: urls.get(key) ?? null };
}
