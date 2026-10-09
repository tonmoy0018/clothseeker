import { z } from "zod";

import { assertCustomer, type Actor } from "@/lib/auth/policy";
import { compareSizes } from "@/lib/catalog/size-chart";
import { getCustomizationTemplate, type CustomerTemplate } from "@/lib/catalog/template-loader";
import type { PrismaClient } from "@/lib/db/client";
import type { Size } from "@/lib/generated/prisma/enums";
import { ImageValidationError, processImage } from "@/lib/media/process-image";
import { renderPreview, storageAssets } from "@/lib/renderer/render";
import type { StorageAdapter } from "@/lib/storage/adapter";
import { BUCKETS } from "@/lib/storage/buckets";
import { buildObjectKey } from "@/lib/storage/object-key";
import { parseDesignSpec, type DesignSpec } from "@/types/design-spec";

import { normalizeForRender } from "./normalize";
import { basePriceForSize, priceDesign, type DesignPrice } from "./pricing";
import { validateDesignAgainstTemplate, type DesignIssue } from "./validate";

// Customer design workflows. Every write re-parses the spec, revalidates it against the CURRENT
// live template, and recomputes the price on the server — the client's copy is only a proposal.

export type DesignErrorCode = "NOT_FOUND" | "NOT_CUSTOMIZABLE" | "INVALID" | "UPLOAD_INVALID";

export class DesignError extends Error {
  override readonly name = "DesignError";

  constructor(
    readonly code: DesignErrorCode,
    message: string,
    readonly issues: readonly DesignIssue[] = [],
  ) {
    super(message);
  }
}

export type DesignContext = {
  template: CustomerTemplate;
  availableSizes: Size[];
  /** Base price per size (cheapest active variant in that size). */
  basePrices: Partial<Record<Size, number>>;
};

/** Everything needed to design a product, or null if it isn't customizable right now. */
export async function loadDesignContext(
  db: PrismaClient,
  storage: StorageAdapter,
  productId: unknown,
  options: { signImages?: boolean } = {},
): Promise<DesignContext | null> {
  const template = await getCustomizationTemplate(db, storage, productId, options);
  if (!template) {
    return null;
  }
  const variants = await db.variant.findMany({
    where: { productId: template.productId, isActive: true },
    select: { size: true, priceMinor: true, isActive: true },
  });
  const basePrices: Partial<Record<Size, number>> = {};
  const availableSizes: Size[] = [];
  for (const size of [...new Set(variants.map((v) => v.size))].sort(compareSizes)) {
    const price = basePriceForSize(variants, size);
    if (price !== null) {
      basePrices[size] = price;
      availableSizes.push(size);
    }
  }
  if (availableSizes.length === 0) {
    return null;
  }
  return { template, availableSizes, basePrices };
}

export type CheckedDesign = { spec: DesignSpec; price: DesignPrice; context: DesignContext };

/** Parses, revalidates and prices a spec for a customer against the live template. */
export async function checkDesign(
  db: PrismaClient,
  storage: StorageAdapter,
  customerId: string,
  rawSpec: unknown,
): Promise<CheckedDesign> {
  let spec: DesignSpec;
  try {
    spec = parseDesignSpec(rawSpec);
  } catch {
    throw new DesignError("INVALID", "This design couldn't be read. Please refresh and try again.");
  }
  const context = await loadDesignContext(db, storage, spec.productId, { signImages: false });
  if (!context) {
    throw new DesignError("NOT_CUSTOMIZABLE", "This dress can't be customized right now.");
  }
  // Older designs are checked against the current template and re-stamped with its version.
  spec = { ...spec, templateId: context.template.templateId, templateVersion: context.template.version };
  const issues = validateDesignAgainstTemplate(spec, context.template.config, {
    productId: context.template.productId,
    templateId: context.template.templateId,
    availableSizes: context.availableSizes,
    customerId,
  });
  if (issues.length > 0) {
    throw new DesignError("INVALID", issues[0]?.message ?? "Please check your design.", issues);
  }
  const base = context.basePrices[spec.size];
  if (base === undefined) {
    throw new DesignError("INVALID", `Size ${spec.size} isn't available for this dress.`);
  }
  return { spec, price: priceDesign(spec, context.template.config, base), context };
}

const designIdSchema = z.uuid();

export type OrderableDesign = {
  designId: string;
  productName: string;
  spec: DesignSpec;
  price: DesignPrice;
  template: CustomerTemplate;
};

/**
 * A customer's saved design, re-validated and re-priced against the live template, ready to be frozen
 * into an order. Throws DesignError if it can't be ordered as it is.
 */
export async function checkSavedDesignForOrder(
  db: PrismaClient,
  storage: StorageAdapter,
  customerId: string,
  designId: string,
): Promise<OrderableDesign> {
  const design = await db.design.findFirst({ where: { id: designId, customerId }, select: { id: true, spec: true } });
  if (!design) {
    throw new DesignError("NOT_FOUND", "A design in your cart no longer exists.");
  }
  const { spec, price, context } = await checkDesign(db, storage, customerId, design.spec);
  return { designId: design.id, productName: context.template.productName, spec, price, template: context.template };
}

export type SavedDesign = { designId: string; price: DesignPrice; previewKey: string };

/** Creates or updates the customer's own design, with a freshly rendered front preview. */
export async function saveDesign(
  db: PrismaClient,
  storage: StorageAdapter,
  actor: Actor,
  input: { designId?: unknown; spec: unknown },
): Promise<SavedDesign> {
  assertCustomer(actor);
  const { spec, price, context } = await checkDesign(db, storage, actor.id, input.spec);

  let existing: { id: string; previewKey: string | null } | null = null;
  if (input.designId !== undefined && input.designId !== null && input.designId !== "") {
    const designId = designIdSchema.safeParse(input.designId);
    existing = designId.success
      ? await db.design.findFirst({ where: { id: designId.data, customerId: actor.id }, select: { id: true, previewKey: true } })
      : null;
    if (!existing) {
      throw new DesignError("NOT_FOUND", "That design doesn't exist or isn't yours.");
    }
  }

  const preview = await renderPreview(normalizeForRender(spec, context.template.config), "front", storageAssets(storage));
  const previewKey = buildObjectKey(BUCKETS.designAssets, { ownerId: actor.id, category: "previews", extension: "png" });
  await storage.put(BUCKETS.designAssets, previewKey, preview, "image/png");

  try {
    const data = {
      productId: spec.productId,
      templateId: spec.templateId,
      templateVersion: spec.templateVersion,
      spec,
      startedFrom: spec.startedFrom === "photo" ? ("PHOTO" as const) : spec.startedFrom === "description" ? ("DESCRIPTION" as const) : ("SHOP" as const),
      referencePhotoKey: spec.referencePhotoKey ?? null,
      previewKey,
      status: "SAVED" as const,
    };
    const design = existing
      ? await db.design.update({ where: { id: existing.id }, data, select: { id: true } })
      : await db.design.create({ data: { ...data, customerId: actor.id }, select: { id: true } });
    if (existing?.previewKey) {
      await storage.remove(BUCKETS.designAssets, [existing.previewKey]).catch(() => undefined);
    }
    return { designId: design.id, price, previewKey };
  } catch (error) {
    await storage.remove(BUCKETS.designAssets, [previewKey]).catch(() => undefined);
    throw error;
  }
}

/** Puts a saved design in the cart once (re-validated and re-priced). */
export async function addDesignToCart(
  db: PrismaClient,
  storage: StorageAdapter,
  actor: Actor,
  rawDesignId: unknown,
): Promise<void> {
  assertCustomer(actor);
  const designId = designIdSchema.safeParse(rawDesignId);
  const design = designId.success
    ? await db.design.findFirst({ where: { id: designId.data, customerId: actor.id }, select: { id: true, spec: true } })
    : null;
  if (!design) {
    throw new DesignError("NOT_FOUND", "That design doesn't exist or isn't yours.");
  }
  await checkDesign(db, storage, actor.id, design.spec);

  await db.$transaction(async (tx) => {
    const cart = await tx.cart.upsert({ where: { customerId: actor.id }, create: { customerId: actor.id }, update: {}, select: { id: true } });
    const already = await tx.cartItem.count({ where: { cartId: cart.id, designId: design.id } });
    if (already === 0) {
      await tx.cartItem.create({ data: { cartId: cart.id, kind: "CUSTOM_DESIGN", designId: design.id, quantity: 1 } });
    }
  });
}

/** Stores a customer's image for use in a design layer. Returns its key and a preview URL. */
export async function uploadDesignImage(
  storage: StorageAdapter,
  actor: Actor,
  bytes: Uint8Array,
): Promise<{ key: string; url: string | null }> {
  assertCustomer(actor);
  let image;
  try {
    image = await processImage(bytes, "designUpload");
  } catch (error) {
    if (error instanceof ImageValidationError) {
      throw new DesignError("UPLOAD_INVALID", error.message);
    }
    throw error;
  }
  const key = buildObjectKey(BUCKETS.designAssets, { ownerId: actor.id, category: "uploads", extension: image.extension });
  await storage.put(BUCKETS.designAssets, key, image.data, image.contentType);
  const urls = await storage.signReadUrls(BUCKETS.designAssets, [key]);
  return { key, url: urls.get(key) ?? null };
}

/** Deletes the customer's own saved design (and its cart lines and preview). Ordered designs are kept. */
export async function deleteDesign(db: PrismaClient, storage: StorageAdapter, actor: Actor, rawDesignId: unknown): Promise<void> {
  assertCustomer(actor);
  const designId = designIdSchema.safeParse(rawDesignId);
  const design = designId.success
    ? await db.design.findFirst({ where: { id: designId.data, customerId: actor.id }, select: { id: true, status: true, previewKey: true } })
    : null;
  if (!design) {
    throw new DesignError("NOT_FOUND", "That design doesn't exist or isn't yours.");
  }
  if (design.status === "ORDERED") {
    throw new DesignError("INVALID", "Designs that were ordered are kept with the order.");
  }
  await db.$transaction(async (tx) => {
    await tx.cartItem.deleteMany({ where: { designId: design.id } });
    await tx.design.delete({ where: { id: design.id } });
  });
  if (design.previewKey) {
    await storage.remove(BUCKETS.designAssets, [design.previewKey]).catch(() => undefined);
  }
}

/** `saved` is false for hidden drafts (designs the AI box created before the customer pressed Save). */
export type DesignForEdit = { designId: string; spec: DesignSpec; uploadUrls: Record<string, string>; saved: boolean };

/** The customer's own design for the editor, or null. Image layers get signed URLs. */
export async function getDesignForEdit(
  db: PrismaClient,
  storage: StorageAdapter,
  actor: Actor,
  rawDesignId: unknown,
  productId: string,
): Promise<DesignForEdit | null> {
  const designId = designIdSchema.safeParse(rawDesignId);
  if (!designId.success) {
    return null;
  }
  const design = await db.design.findFirst({
    where: { id: designId.data, customerId: actor.id, productId },
    select: { id: true, spec: true, status: true },
  });
  if (!design) {
    return null;
  }
  let spec: DesignSpec;
  try {
    spec = parseDesignSpec(design.spec);
  } catch {
    return null;
  }
  const keys = spec.layers.flatMap((l) => (l.kind === "image" ? [l.image.assetKey] : []));
  const urls = await storage.signReadUrls(BUCKETS.designAssets, keys);
  return { designId: design.id, spec, uploadUrls: Object.fromEntries(urls), saved: design.status !== "DRAFT" };
}

export type DesignPriceCheck = { price: DesignPrice; issue: null } | { price: null; issue: string };

/** Current server price of a stored design, or why it can't be bought as-is. */
export async function priceStoredDesign(
  db: PrismaClient,
  storage: StorageAdapter,
  customerId: string,
  rawSpec: unknown,
): Promise<DesignPriceCheck> {
  try {
    const { price } = await checkDesign(db, storage, customerId, rawSpec);
    return { price, issue: null };
  } catch (error) {
    if (error instanceof DesignError) {
      return { price: null, issue: error.code === "NOT_CUSTOMIZABLE" ? "No longer customizable" : "Needs changes" };
    }
    throw error;
  }
}

export type DesignSummary = {
  id: string;
  productId: string;
  productName: string;
  previewKey: string | null;
  updatedAt: Date;
  check: DesignPriceCheck;
};

/** The customer's saved designs, newest first, each priced against the current template. */
export async function listDesigns(db: PrismaClient, storage: StorageAdapter, actor: Actor): Promise<DesignSummary[]> {
  const designs = await db.design.findMany({
    where: { customerId: actor.id, status: { in: ["SAVED", "ORDERED"] } },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: { id: true, productId: true, previewKey: true, updatedAt: true, spec: true, product: { select: { name: true } } },
  });
  const summaries: DesignSummary[] = [];
  for (const d of designs) {
    summaries.push({
      id: d.id,
      productId: d.productId,
      productName: d.product.name,
      previewKey: d.previewKey,
      updatedAt: d.updatedAt,
      check: await priceStoredDesign(db, storage, actor.id, d.spec),
    });
  }
  return summaries;
}
