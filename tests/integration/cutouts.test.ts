import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { ForbiddenError, type Actor } from "@/lib/auth/policy";
import { CUTOUT_DAILY_LIMIT, CUTOUT_LIMIT_MESSAGE } from "@/lib/cutouts/rules";
import { createCutout, CutoutServiceError, cutoutsByKey, listCutouts, listCutoutSources } from "@/lib/cutouts/service";
import { saveDesign, DesignError } from "@/lib/design/service";
import { BUCKETS } from "@/lib/storage/buckets";
import type { MemoryStorageAdapter } from "@/lib/storage/memory";
import type { DesignSpec } from "@/types/design-spec";

import { DECORATED_BOX, decoratedPhoto } from "../fixtures/cutout-photo";
import { storageWithTemplateAssets, TEMPLATE, validSpec } from "../fixtures/design";

import { createProduct, createUser, db, resetDatabaseBeforeEach } from "./helpers";

// Taking a decoration from another ClothSeeker dress: only live products, only the customer's own
// cut-outs, design colours only, 30 a day; then used in a design like a decoration.

resetDatabaseBeforeEach();

let storage: MemoryStorageAdapter;
beforeEach(async () => {
  storage = await storageWithTemplateAssets();
});

/** A live dress with the decorated photo, and a customizable product to design. */
async function setup() {
  const source = await createProduct({ variants: [{ size: "M", color: "Navy", priceMinor: 300_000, stock: 3 }] });
  const photoKey = `${source.id}/products/${randomUUID()}.webp`;
  await storage.put(BUCKETS.productMedia, photoKey, await decoratedPhoto(), "image/png");
  await db.product.update({ where: { id: source.id }, data: { name: "Embroidered Kurti Dress", imageKeys: [photoKey] } });
  const designed = await createProduct({ variants: [{ size: "M", color: "Sage", priceMinor: 320_000, stock: 3 }] });
  const template = await db.customizationTemplate.create({ data: { productId: designed.id, version: 2, config: TEMPLATE, isActive: true } });
  return { source, designed, template };
}

const request = (sourceId: string, designedId: string, extra: Record<string, unknown> = {}) => ({
  productId: sourceId,
  imageIndex: 0,
  box: DECORATED_BOX,
  strength: 0.4,
  designProductId: designedId,
  ...extra,
});

describe("cutting out a decoration", () => {
  it("stores the customer's cut-out privately and lists it with the dress it came from", async () => {
    const { source, designed } = await setup();
    const customer = await createUser();
    const cut = await createCutout(db, storage, customer, request(source.id, designed.id));
    expect(cut.key.startsWith(`${customer.id}/cutouts/`)).toBe(true);
    expect(await storage.get(BUCKETS.designAssets, cut.key)).not.toBeNull();
    expect(cut).toMatchObject({ productName: "Embroidered Kurti Dress", productId: source.id });
    expect(cut.palette.length).toBeGreaterThan(0);

    const mine = await listCutouts(db, storage, customer);
    expect(mine.cutouts.map((c) => c.key)).toEqual([cut.key]);
    expect(mine.left).toBe(CUTOUT_DAILY_LIMIT - 1);
    // Someone else sees none of it.
    expect((await listCutouts(db, storage, await createUser())).cutouts).toEqual([]);
    expect((await listCutoutSources(db, storage, customer)).map((s) => s.name)).toContain("Embroidered Kurti Dress");
  });

  it("only takes from live products, and checks the box and colours", async () => {
    const { source, designed } = await setup();
    const customer = await createUser();
    const code = (input: unknown) => createCutout(db, storage, customer, input).then(() => "ok", (e: unknown) => (e instanceof CutoutServiceError ? e.code : "other"));
    expect(await code(request(source.id, designed.id, { imageIndex: 3 }))).toBe("NOT_FOUND");
    expect(await code(request(source.id, designed.id, { box: { x: 0.9, y: 0.9, w: 0.5, h: 0.5 } }))).toBe("INVALID");
    // Colours come from the design's own template.
    expect(await code(request(source.id, designed.id, { swaps: ["#123456"] }))).toBe("INVALID");
    expect(await code(request(source.id, designed.id, { swaps: [TEMPLATE.allowedColors[0]?.hex.toLowerCase() ?? ""] }))).toBe("ok");
    await db.product.update({ where: { id: source.id }, data: { status: "ARCHIVED" } });
    expect(await code(request(source.id, designed.id))).toBe("NOT_FOUND");
    // Admins don't make designs.
    await expect(createCutout(db, storage, await createUser("ADMIN"), request(source.id, designed.id))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("allows 30 a day, even when two arrive at once, and records the refusal", async () => {
    const { source, designed } = await setup();
    const customer = await createUser();
    await db.decorationCutout.createMany({
      data: Array.from({ length: CUTOUT_DAILY_LIMIT - 1 }, () => ({
        customerId: customer.id,
        productId: source.id,
        productName: "Embroidered Kurti Dress",
        imageIndex: 0,
        settings: {},
        imageKey: `${customer.id}/cutouts/${randomUUID()}.webp`,
        width: 10,
        height: 10,
        palette: [],
      })),
    });
    const results = await Promise.allSettled([0, 1].map(() => createCutout(db, storage, customer, request(source.id, designed.id))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected");
    expect(refused?.status === "rejected" && refused.reason instanceof CutoutServiceError && refused.reason.message).toBe(CUTOUT_LIMIT_MESSAGE);
    expect(await db.decorationCutout.count({ where: { customerId: customer.id } })).toBe(CUTOUT_DAILY_LIMIT);
    expect(await db.aiLimitHit.count({ where: { customerId: customer.id, feature: "CUTOUT" } })).toBe(1);
    // Only the accepted one's file is kept.
    const stored = [...storage.objects.keys()].filter((id) => id.includes(`${customer.id}/cutouts/`));
    expect(stored).toHaveLength(1);
  });
});

describe("using a cut-out in a design", () => {
  it("is saved and priced like a decoration border; nobody else can use it", async () => {
    const { source, designed, template } = await setup();
    const customer: Actor = await createUser();
    const cut = await createCutout(db, storage, customer, request(source.id, designed.id));
    const base = validSpec({ productId: designed.id, templateId: template.id, templateVersion: 2 });
    const spec: DesignSpec = {
      ...base,
      layers: [
        ...base.layers.filter((l) => l.kind !== "decoration"),
        { id: "c1", areaId: "front-chest", kind: "image", x: 0, y: 0.55, w: 1, h: 0.3, rotation: 0, image: { assetKey: cut.key, mirror: true, repeat: { count: 4, curve: 0.3 } } },
      ],
    };
    const saved = await saveDesign(db, storage, customer, { spec });
    expect(saved.price.lines).toContainEqual({ label: "Decoration × 4", amountMinor: 4 * TEMPLATE.addOns.decorationMinor });

    await expect(saveDesign(db, storage, await createUser(), { spec })).rejects.toBeInstanceOf(DesignError);
    // Production names the dress it came from.
    expect((await cutoutsByKey(db, [cut.key])).get(cut.key)).toMatchObject({ productName: "Embroidered Kurti Dress" });
  });
});
