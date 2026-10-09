import { z } from "zod";

import { assertCustomer, type Actor } from "@/lib/auth/policy";
import { checkSavedDesignForOrder, DesignError, loadDesignContext, type OrderableDesign } from "@/lib/design/service";
import { canAcceptQuote } from "@/lib/quotes/rules";
import { parseDesignSpec, type DesignSpec } from "@/types/design-spec";
import type { TemplateConfig } from "@/types/template";
import { normalizeForRender } from "@/lib/design/normalize";
import type { PrismaClient } from "@/lib/db/client";
import { Prisma } from "@/lib/generated/prisma/client";
import type { DeliveryZone, Size } from "@/lib/generated/prisma/enums";
import { CURRENCY, lineTotalMinor } from "@/lib/money";
import type { PaymentProvider } from "@/lib/payments/types";
import { renderPreview, renderPrintFiles, storageAssets } from "@/lib/renderer/render";
import type { StorageAdapter } from "@/lib/storage/adapter";
import { BUCKETS } from "@/lib/storage/buckets";
import { buildObjectKey } from "@/lib/storage/object-key";

import { checkoutTotals, deliveryZoneSchema, shippingAddressSchema, type CheckoutTotals } from "./delivery";
import { OrderError } from "./errors";
import { expireStalePendingOrders } from "./expiry";
import { generateOrderNumber } from "./number";
import type { StoredPrintFile } from "./print-files";

// Checkout: server-priced cart → PENDING_PAYMENT order (stock reserved, designs frozen with print
// files) → payment created with the gateway → customer redirected to pay. The webhook
// (lib/orders/payments.ts) finishes the order. The cart is only cleared once payment succeeds.

export const PENDING_ORDER_TTL_MS = 30 * 60 * 1000;

type ReadyMadeCheckoutLine = {
  kind: "READY_MADE";
  cartItemId: string;
  variantId: string;
  productName: string;
  size: Size;
  colorName: string;
  unitPriceMinor: number;
  quantity: number;
};

type CustomCheckoutLine = {
  kind: "CUSTOM_DESIGN";
  cartItemId: string;
  design: OrderableDesign;
  unitPriceMinor: number;
  quantity: 1;
};

/** An accepted tailoring quote: the design snapshot at the team's quoted price. */
type QuoteCheckoutLine = {
  kind: "QUOTE";
  cartItemId: string;
  quoteId: string;
  designId: string;
  productName: string;
  spec: DesignSpec;
  template: { config: TemplateConfig };
  unitPriceMinor: number;
  quantity: 1;
};

export type CheckoutLine = ReadyMadeCheckoutLine | CustomCheckoutLine | QuoteCheckoutLine;

/** The customer's cart, fully re-priced and re-validated. Throws OrderError if it can't be bought as is. */
async function loadCheckoutLines(db: PrismaClient, storage: StorageAdapter, customerId: string): Promise<CheckoutLine[]> {
  const items = await db.cartItem.findMany({
    where: { cart: { customerId } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      kind: true,
      quantity: true,
      designId: true,
      quoteRequest: {
        select: {
          id: true,
          customerId: true,
          status: true,
          priceMinor: true,
          respondBy: true,
          expiresAt: true,
          specSnapshot: true,
          designId: true,
          design: { select: { product: { select: { name: true } } } },
        },
      },
      variant: {
        select: {
          id: true,
          size: true,
          colorName: true,
          priceMinor: true,
          stock: true,
          isActive: true,
          product: { select: { name: true, status: true } },
        },
      },
    },
  });
  if (items.length === 0) {
    throw new OrderError("CART_EMPTY", "Your cart is empty.");
  }

  const lines: CheckoutLine[] = [];
  for (const item of items) {
    if (item.kind === "READY_MADE") {
      const v = item.variant;
      if (!v || !v.isActive || v.product.status !== "ACTIVE") {
        throw new OrderError("CART_CHANGED", "An item in your cart is no longer available. Please review your cart.");
      }
      if (v.stock < item.quantity) {
        throw new OrderError("INSUFFICIENT_STOCK", `${v.product.name} (${v.size}, ${v.colorName}) doesn't have enough stock left.`);
      }
      lines.push({
        kind: "READY_MADE",
        cartItemId: item.id,
        variantId: v.id,
        productName: v.product.name,
        size: v.size,
        colorName: v.colorName,
        unitPriceMinor: v.priceMinor,
        quantity: item.quantity,
      });
    } else if (item.kind === "CUSTOM_DESIGN" && item.designId) {
      try {
        const design = await checkSavedDesignForOrder(db, storage, customerId, item.designId);
        lines.push({ kind: "CUSTOM_DESIGN", cartItemId: item.id, design, unitPriceMinor: design.price.totalMinor, quantity: 1 });
      } catch (error) {
        if (error instanceof DesignError) {
          throw new OrderError("CART_CHANGED", "A design in your cart needs changes before it can be ordered. Open it from your cart to fix it.");
        }
        throw error;
      }
    } else if (item.kind === "QUOTE" && item.quoteRequest) {
      const quote = item.quoteRequest;
      if (quote.customerId !== customerId || !canAcceptQuote(quote, new Date()) || quote.priceMinor === null) {
        throw new OrderError("CART_CHANGED", "A tailoring quote in your cart has expired or was closed. Remove it to continue.");
      }
      let spec: DesignSpec;
      try {
        spec = parseDesignSpec(quote.specSnapshot);
      } catch {
        throw new OrderError("CART_CHANGED", "A tailoring quote in your cart can't be ordered. Please contact us.");
      }
      const context = await loadDesignContext(db, storage, spec.productId, { signImages: false });
      if (!context) {
        throw new OrderError("CART_CHANGED", "The dress for a tailoring quote in your cart is no longer available.");
      }
      lines.push({
        kind: "QUOTE",
        cartItemId: item.id,
        quoteId: quote.id,
        designId: quote.designId,
        productName: quote.design.product.name,
        spec,
        template: { config: context.template.config },
        unitPriceMinor: quote.priceMinor,
        quantity: 1,
      });
    } else {
      throw new OrderError("CART_CHANGED", "An item in your cart is no longer available. Please review your cart.");
    }
  }
  return lines;
}

export type CheckoutQuote = { lines: CheckoutLine[] } & CheckoutTotals;

/** What the customer will pay for a delivery zone. */
export async function quoteCheckout(
  db: PrismaClient,
  storage: StorageAdapter,
  actor: Actor,
  zone: DeliveryZone,
): Promise<CheckoutQuote> {
  assertCustomer(actor);
  const lines = await loadCheckoutLines(db, storage, actor.id);
  return { lines, ...checkoutTotals(lines.map((l) => lineTotalMinor(l.unitPriceMinor, l.quantity)), zone) };
}

export const placeOrderSchema = z.object({
  idempotencyKey: z.uuid(),
  zone: deliveryZoneSchema,
  address: shippingAddressSchema,
  /** Optional note for the tailors; printed on the production spec sheet. */
  customerNote: z
    .string()
    .trim()
    .max(300, "Notes can be at most 300 characters")
    .optional()
    .transform((v) => (v ? v : undefined)),
});

export type PlacedOrder = { orderId: string; orderNumber: string; redirectUrl: string; reused: boolean };

type RenderedDesign = { previewKey: string; printFiles: StoredPrintFile[] };

/** Freezes a design's preview and 300 DPI print files under the customer's orders prefix. */
async function renderForOrder(storage: StorageAdapter, customerId: string, design: Pick<OrderableDesign, "spec"> & { template: { config: TemplateConfig } }): Promise<RenderedDesign> {
  const plan = normalizeForRender(design.spec, design.template.config);
  const assets = storageAssets(storage);
  const keyFor = () => buildObjectKey(BUCKETS.designAssets, { ownerId: customerId, category: "orders", extension: "png" });

  const previewKey = keyFor();
  await storage.put(BUCKETS.designAssets, previewKey, await renderPreview(plan, "front", assets), "image/png");
  const printFiles: StoredPrintFile[] = [];
  for (const file of await renderPrintFiles(plan, assets)) {
    const key = keyFor();
    await storage.put(BUCKETS.designAssets, key, file.png, "image/png");
    printFiles.push({ areaId: file.areaId, label: file.label, key, widthPx: file.widthPx, heightPx: file.heightPx, widthCm: file.widthCm, heightCm: file.heightCm });
  }
  return { previewKey, printFiles };
}

export async function placeOrder(
  db: PrismaClient,
  storage: StorageAdapter,
  provider: PaymentProvider,
  actor: Actor,
  rawInput: unknown,
  options: { now?: Date; returnUrlFor: (orderId: string) => string },
): Promise<PlacedOrder> {
  assertCustomer(actor);
  const input = placeOrderSchema.parse(rawInput);
  const now = options.now ?? new Date();

  // 1. A repeated submission (double click, retry, back button) resumes the same order.
  const existing = await db.order.findUnique({ where: { idempotencyKey: input.idempotencyKey }, select: { id: true } });
  if (existing) {
    return resumeOrder(db, provider, actor, existing.id, input.idempotencyKey, options);
  }

  // 2. Free stock held by this customer's abandoned checkouts, then re-price the cart.
  await expireStalePendingOrders(db, storage, now, { customerId: actor.id });
  const lines = await loadCheckoutLines(db, storage, actor.id);
  const totals = checkoutTotals(lines.map((l) => lineTotalMinor(l.unitPriceMinor, l.quantity)), input.zone);

  // 3. Render designs before the transaction (slow, and must not hold row locks).
  const rendered = new Map<string, RenderedDesign>();
  const renderedKeys: string[] = [];
  const cleanup = () => storage.remove(BUCKETS.designAssets, renderedKeys).catch(() => undefined);
  try {
    for (const line of lines) {
      if (line.kind === "CUSTOM_DESIGN" || line.kind === "QUOTE") {
        const files = await renderForOrder(storage, actor.id, line.kind === "QUOTE" ? line : line.design);
        rendered.set(line.cartItemId, files);
        renderedKeys.push(files.previewKey, ...files.printFiles.map((f) => f.key));
      }
    }
  } catch (error) {
    await cleanup();
    throw error;
  }

  // 4. Reserve stock and create the order atomically.
  let order: { id: string; number: string };
  try {
    order = await db.$transaction(async (tx) => {
      for (const line of lines) {
        if (line.kind !== "READY_MADE") continue;
        const reserved = await tx.variant.updateMany({
          where: { id: line.variantId, isActive: true, stock: { gte: line.quantity } },
          data: { stock: { decrement: line.quantity } },
        });
        if (reserved.count !== 1) {
          throw new OrderError("INSUFFICIENT_STOCK", `${line.productName} (${line.size}, ${line.colorName}) doesn't have enough stock left.`);
        }
      }
      const created = await tx.order.create({
        data: {
          number: generateOrderNumber(now),
          customerId: actor.id,
          status: "PENDING_PAYMENT",
          idempotencyKey: input.idempotencyKey,
          currency: CURRENCY,
          ...totals,
          deliveryZone: input.zone,
          expiresAt: new Date(now.getTime() + PENDING_ORDER_TTL_MS),
          shippingName: input.address.name,
          shippingPhone: input.address.phone,
          shippingLine1: input.address.line1,
          shippingLine2: input.address.line2 ?? null,
          shippingCity: input.address.city,
          shippingPostalCode: input.address.postalCode ?? null,
          customerNote: input.customerNote ?? null,
          items: {
            create: lines.map((line) =>
              line.kind === "READY_MADE"
                ? {
                    kind: "READY_MADE" as const,
                    variantId: line.variantId,
                    productName: line.productName,
                    size: line.size,
                    colorName: line.colorName,
                    unitPriceMinor: line.unitPriceMinor,
                    quantity: line.quantity,
                  }
                : line.kind === "QUOTE"
                  ? {
                      kind: "QUOTE" as const,
                      designId: line.designId,
                      quoteRequestId: line.quoteId,
                      productName: line.productName,
                      size: line.spec.size,
                      unitPriceMinor: line.unitPriceMinor,
                      quantity: 1,
                      designSpec: line.spec,
                      previewKey: rendered.get(line.cartItemId)?.previewKey ?? null,
                      printFiles: rendered.get(line.cartItemId)?.printFiles ?? [],
                    }
                  : {
                    kind: "CUSTOM_DESIGN" as const,
                    designId: line.design.designId,
                    productName: line.design.productName,
                    size: line.design.spec.size,
                    unitPriceMinor: line.unitPriceMinor,
                    quantity: 1,
                    designSpec: line.design.spec,
                    previewKey: rendered.get(line.cartItemId)?.previewKey ?? null,
                    printFiles: rendered.get(line.cartItemId)?.printFiles ?? [],
                  },
            ),
          },
        },
        select: { id: true, number: true },
      });
      await tx.orderEvent.create({
        data: { orderId: created.id, toStatus: "PENDING_PAYMENT", actorType: "CUSTOMER", actorId: actor.id, note: "Order placed" },
      });
      return created;
    });
  } catch (error) {
    await cleanup();
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // A concurrent submission with the same key won the race.
      const winner = await db.order.findUnique({ where: { idempotencyKey: input.idempotencyKey }, select: { id: true } });
      if (winner) {
        return resumeOrder(db, provider, actor, winner.id, input.idempotencyKey, options);
      }
    }
    throw error;
  }

  // 5. Create the payment with the gateway.
  const payment = await provider.createPayment({
    orderId: order.id,
    orderNumber: order.number,
    amountMinor: totals.totalMinor,
    currency: CURRENCY,
    idempotencyKey: input.idempotencyKey,
    returnUrl: options.returnUrlFor(order.id),
  });
  await db.$transaction([
    db.payment.upsert({
      where: { providerRef: payment.providerRef },
      create: { orderId: order.id, provider: provider.name, providerRef: payment.providerRef, amountMinor: totals.totalMinor, currency: CURRENCY },
      update: {},
    }),
    db.order.update({ where: { id: order.id }, data: { paymentRef: payment.providerRef } }),
  ]);
  return { orderId: order.id, orderNumber: order.number, redirectUrl: payment.redirectUrl, reused: false };
}

/** Same key again: hand back the existing order's payment page (if it can still be paid). */
async function resumeOrder(
  db: PrismaClient,
  provider: PaymentProvider,
  actor: Actor,
  orderId: string,
  idempotencyKey: string,
  options: { returnUrlFor: (orderId: string) => string },
): Promise<PlacedOrder> {
  const order = await db.order.findFirst({
    where: { id: orderId, customerId: actor.id },
    select: { id: true, number: true, totalMinor: true, currency: true },
  });
  if (!order) {
    throw new OrderError("NOT_FOUND", "We couldn't find that checkout.");
  }
  const payment = await provider.createPayment({
    orderId: order.id,
    orderNumber: order.number,
    amountMinor: order.totalMinor,
    currency: order.currency,
    idempotencyKey,
    returnUrl: options.returnUrlFor(order.id),
  });
  await db.payment.upsert({
    where: { providerRef: payment.providerRef },
    create: { orderId: order.id, provider: provider.name, providerRef: payment.providerRef, amountMinor: order.totalMinor, currency: order.currency },
    update: {},
  });
  return { orderId: order.id, orderNumber: order.number, redirectUrl: payment.redirectUrl, reused: true };
}

/** "Complete payment" for one of the customer's own pending, unexpired orders. */
export async function resumePayment(
  db: PrismaClient,
  provider: PaymentProvider,
  actor: Actor,
  rawOrderId: unknown,
  options: { now?: Date; returnUrlFor: (orderId: string) => string },
): Promise<PlacedOrder> {
  assertCustomer(actor);
  const orderId = z.uuid().safeParse(rawOrderId);
  const order = orderId.success
    ? await db.order.findFirst({
        where: { id: orderId.data, customerId: actor.id },
        select: { id: true, status: true, expiresAt: true, idempotencyKey: true },
      })
    : null;
  if (!order) {
    throw new OrderError("NOT_FOUND", "We couldn't find that order.");
  }
  const now = options.now ?? new Date();
  if (order.status !== "PENDING_PAYMENT" || (order.expiresAt && order.expiresAt < now)) {
    throw new OrderError("EXPIRED", "This order can no longer be paid. Please check out again from your cart.");
  }
  return resumeOrder(db, provider, actor, order.id, order.idempotencyKey, options);
}

