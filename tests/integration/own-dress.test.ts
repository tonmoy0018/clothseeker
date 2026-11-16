import { readFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";

import { getAdminProduct, listAdminProducts } from "@/lib/admin/products";
import { AiError, AiProviderError, BRAND_LOGO_MESSAGE } from "@/lib/ai/errors";
import { FAKE_LOGO_MARKER, FakeImage, FakePhotoChecker, FakePlanner, FakeSketch, FakeTryOn } from "@/lib/ai/providers/fake";
import { createDesignRoundJob, getJobStatus } from "@/lib/ai/jobs";
import { storedOptionsSchema } from "@/lib/ai/rounds";
import { getStartStatus, startDesignFrom, uploadReferencePhoto } from "@/lib/ai/starts";
import type { GarmentShotProvider, PlannerProvider, SketchRenderer } from "@/lib/ai/types";
import { processNextJob, type AiWorkerDeps } from "@/lib/ai/worker/run";
import type { Actor } from "@/lib/auth/policy";
import { getCustomizationTemplate } from "@/lib/catalog/template-loader";
import { addDesignToCart, DesignError, listDesigns, loadDesignContext, saveDesign } from "@/lib/design/service";
import { validateDesignAgainstTemplate } from "@/lib/design/validate";
import { AS_PHOTO } from "@/lib/own-dress/build";
import { listMyQuotes, QuoteError, requestQuote } from "@/lib/quotes/service";
import { getProductBySlug, listProducts } from "@/lib/shop/catalog";
import type { MemoryStorageAdapter } from "@/lib/storage/memory";
import { parseDesignSpec } from "@/types/design-spec";

import { storageWithTemplateAssets } from "../fixtures/design";
import { sketchDrawing } from "../fixtures/sketch";

import { createProduct, createUser, db, resetDatabaseBeforeEach } from "./helpers";

// A customer's own dress, made from their photo (decided 2026-11-02): a PRIVATE product with its own
// template that only they can design on, never in the shop or the team's catalogue, ordered through a quote.

resetDatabaseBeforeEach();

let storage: MemoryStorageAdapter;
beforeEach(async () => {
  storage = await storageWithTemplateAssets();
  // A catalogue dress (and the category an own dress is filed under).
  await createProduct({ variants: [{ size: "M", color: "Sage", priceMinor: 320_000, stock: 3 }] });
});

function deps(planner: PlannerProvider = new FakePlanner(), garmentShot?: GarmentShotProvider, sketch: SketchRenderer = new FakeSketch()): AiWorkerDeps {
  return {
    db,
    storage,
    providers: { planner, image: new FakeImage(), tryOn: new FakeTryOn(), photoCheck: new FakePhotoChecker(), sketch, ...(garmentShot ? { garmentShot } : {}) },
    workerId: "worker-a",
    timeoutMs: 30_000,
    backoffMs: () => 0,
  };
}

/** An AI-generated catalogue photo of a dress on a plain backdrop. */
const dressPhoto = () => readFile(path.join(process.cwd(), "prisma", "seed-photos", "cotton-tiered-midi.jpg"));

async function ownDress(
  customer: Actor,
  exact: boolean,
  photo?: Buffer,
  options: { garmentType?: string; planner?: PlannerProvider; garmentShot?: GarmentShotProvider; sketch?: { note?: string; renderer?: SketchRenderer } } = {},
) {
  const reference = await uploadReferencePhoto(storage, customer, photo ?? (await dressPhoto()));
  const fromSketch = options.sketch ? { sketch: true, note: options.sketch.note } : {};
  const { jobId } = await startDesignFrom(db, storage, customer, { mode: "own", referenceKey: reference.key, garmentType: options.garmentType ?? "auto", exact, ...fromSketch });
  await processNextJob(deps(options.planner, options.garmentShot, options.sketch?.renderer));
  return { jobId, referenceKey: reference.key, status: await getStartStatus(db, storage, customer, jobId) };
}

async function built(customer: Actor, exact = false) {
  const { status, referenceKey } = await ownDress(customer, exact);
  if (status.state !== "done") throw new Error(`expected done, got ${JSON.stringify(status)}`);
  return { ...status.result, referenceKey };
}

describe("your own dress from a photo", () => {
  it("becomes a private dress with its own template and a draft design on it, cut as in the photo", async () => {
    const ava = await createUser();
    const { productId, designId, alternatives, referenceKey } = await built(ava);
    expect(alternatives).toEqual([]);

    const product = await db.product.findUniqueOrThrow({ where: { id: productId }, include: { variants: true, template: true } });
    // What the AI read: a tiered midi dress (the fake planner's reading).
    expect(product).toMatchObject({ status: "PRIVATE", ownerId: ava.id, garmentType: "dress", name: "Your tiered midi dress" });
    expect(product.description).toContain("Details: Tiered skirt.");
    expect(product.variants.map((v) => v.size).sort()).toEqual(["L", "M", "S", "XL", "XS", "XXL"]);
    expect(product.template).toMatchObject({ isActive: true, aiEnabled: true });

    const design = await db.design.findUniqueOrThrow({ where: { id: designId } });
    expect(design).toMatchObject({ customerId: ava.id, productId, status: "DRAFT", startedFrom: "PHOTO", referencePhotoKey: referenceKey, referenceIsDrawing: false });
    const spec = parseDesignSpec(design.spec);
    expect(Object.values(spec.styleOptions).every((option) => option === AS_PHOTO)).toBe(true);
    expect(spec.parts).toEqual({});

    const context = await loadDesignContext(db, storage, productId, { viewerId: ava.id });
    expect(context?.template.ownDress).toBe(true);
    // Recolourable parts cut from the photo, and somewhere to add text and decorations.
    expect(context?.template.config.regions.map((r) => r.id)).toEqual(expect.arrayContaining(["bodice", "skirt"]));
    expect(context?.template.config.placementAreas.length).toBeGreaterThan(0);
    expect(context?.template.config.recolor).toBe("shade");
  });

  it("is read by the AI: its type unless the customer chose one, its name, style and details for the team", async () => {
    const ava = await createUser();
    const { productId } = await built(ava);
    const context = await loadDesignContext(db, storage, productId, { viewerId: ava.id });
    const config = context?.template.config;
    expect(config?.styleOptions.neckline?.[0]?.label).toBe("Strapless");
    expect(config?.styleOptions.sleeveLength?.[0]?.label).toBe("Sleeveless");
    expect(config?.styleOptions.dressLength?.[0]?.label).toBe("Midi");

    // The customer's own choice wins over what the AI read.
    const shirt = await ownDress(ava, false, undefined, { garmentType: "shirt" });
    if (shirt.status.state !== "done") throw new Error("expected done");
    expect(await db.product.findUniqueOrThrow({ where: { id: shirt.status.result.productId } })).toMatchObject({ garmentType: "shirt", name: "Your tiered midi dress" });

    // The team sees it with the quote.
    const exact = await built(ava, true);
    const { quoteId } = await requestQuote(db, storage, ava, { designId: exact.designId, notes: "" });
    const [view] = await listMyQuotes(db, storage, ava);
    expect(view?.id).toBe(quoteId);
    expect(view?.garmentDescription).toContain("A softly gathered dress with tiers.");
  });

  it("uses an AI product shot when the image model makes one, and the customer's photo when it can't", async () => {
    const ava = await createUser();
    const maxi = await readFile(path.join(process.cwd(), "prisma", "seed-photos", "block-print-maxi-dress.jpg"));
    const seen: number[] = [];
    const making: GarmentShotProvider = { name: "test", productShot: async (image) => (seen.push(image.data.length), maxi) };
    const made = await ownDress(ava, false, undefined, { garmentShot: making });
    if (made.status.state !== "done") throw new Error(`expected done, got ${JSON.stringify(made.status)}`);
    expect(seen).toHaveLength(1);
    const product = await db.product.findUniqueOrThrow({ where: { id: made.status.result.productId } });
    expect(product.description).toContain("AI product shot");
    // The customer's own photo stays the reference.
    expect(await db.design.findUniqueOrThrow({ where: { id: made.status.result.designId } })).toMatchObject({ referencePhotoKey: expect.stringContaining("/references/") });

    const refusing: GarmentShotProvider = { name: "test", productShot: async () => null };
    const plain = await ownDress(ava, false, undefined, { garmentShot: refusing });
    if (plain.status.state !== "done") throw new Error("expected done");
    expect((await db.product.findUniqueOrThrow({ where: { id: plain.status.result.productId } })).description).not.toContain("AI product shot");
  });

  it("still works when the AI can't read the photo: named and cut out as before", async () => {
    const ava = await createUser();
    const fake = new FakePlanner();
    const silent: PlannerProvider = {
      name: "silent",
      detectBrandLogos: (images, signal) => fake.detectBrandLogos(images, signal),
      planDesign: (request, signal) => fake.planDesign(request, signal),
      matchDress: (request, signal) => fake.matchDress(request, signal),
      readGarment: async () => {
        throw new AiProviderError("down", true);
      },
    };
    const { status } = await ownDress(ava, false, undefined, { planner: silent });
    if (status.state !== "done") throw new Error(`expected done, got ${JSON.stringify(status)}`);
    expect(await db.product.findUniqueOrThrow({ where: { id: status.result.productId } })).toMatchObject({ name: "Your dress", garmentType: "dress" });
  });

  it("gets AI ideas like our dresses: four options on the customer's own dress, its cut kept", async () => {
    const ava = await createUser();
    const { productId, designId } = await built(ava);
    const design = await db.design.findUniqueOrThrow({ where: { id: designId } });
    const queued = await createDesignRoundJob(db, storage, ava, { designId, spec: design.spec, instruction: "Make it emerald with a gold border" });
    expect(await processNextJob(deps())).toBe(true);
    const status = await getJobStatus(db, storage, ava, queued.jobId);
    if (status.state !== "done") throw new Error(`expected done, got ${JSON.stringify(status)}`);
    expect(status.round.options).toHaveLength(4);

    const context = await loadDesignContext(db, storage, productId, { viewerId: ava.id });
    if (!context) throw new Error("no context");
    const round = await db.aIRound.findUniqueOrThrow({ where: { id: status.round.id } });
    for (const option of storedOptionsSchema.parse(round.options)) {
      const spec = parseDesignSpec(option.spec);
      expect(spec.productId).toBe(productId);
      expect(Object.values(spec.styleOptions).every((o) => o === AS_PHOTO)).toBe(true);
      const issues = validateDesignAgainstTemplate(spec, context.template.config, {
        productId,
        templateId: context.template.templateId,
        availableSizes: context.availableSizes,
        customerId: ava.id,
      });
      expect(issues).toEqual([]);
    }
  });

  it("is only ever its owner's: not in the shop, not in the team's catalogue, not loadable by anyone else", async () => {
    const ava = await createUser();
    const bob = await createUser();
    const admin = await createUser("ADMIN");
    const { productId } = await built(ava);
    const product = await db.product.findUniqueOrThrow({ where: { id: productId } });

    expect(await loadDesignContext(db, storage, productId, { viewerId: bob.id })).toBeNull();
    expect(await loadDesignContext(db, storage, productId)).toBeNull();
    expect(await getCustomizationTemplate(db, storage, productId, { viewerId: ava.id })).not.toBeNull();
    const shop = await listProducts(db, {});
    expect(shop.some((p) => p.id === productId)).toBe(false);
    expect(await getProductBySlug(db, product.slug)).toBeNull();
    expect((await listAdminProducts(db, admin, {})).some((p) => p.id === productId)).toBe(false);
    expect(await getAdminProduct(db, admin, productId)).toBeNull();
    await expect(saveDesign(db, storage, bob, { spec: (await db.design.findFirstOrThrow({ where: { productId } })).spec })).rejects.toBeInstanceOf(DesignError);
  });

  it("is ordered only through a quote, which needs no notes", async () => {
    const ava = await createUser();
    const { designId, productId } = await built(ava, true);
    const design = await db.design.findUniqueOrThrow({ where: { id: designId } });
    expect(design.status).toBe("SAVED");
    expect(design.previewKey).not.toBeNull();

    await expect(addDesignToCart(db, storage, ava, designId)).rejects.toMatchObject({ code: "QUOTE_ONLY" });
    expect((await listDesigns(db, storage, ava)).find((d) => d.id === designId)?.check).toEqual({ price: null, issue: "Priced by quote" });

    const { quoteId } = await requestQuote(db, storage, ava, { designId, notes: "" });
    const quote = await db.quoteRequest.findUniqueOrThrow({ where: { id: quoteId }, include: { design: { select: { productId: true } } } });
    expect(quote).toMatchObject({ customerId: ava.id, status: "REQUESTED", notes: "" });
    expect(quote.design.productId).toBe(productId);
  });

  it("still asks for notes when tailoring one of our dresses from a photo", async () => {
    const ava = await createUser();
    const reference = await uploadReferencePhoto(storage, ava, await dressPhoto());
    const product = await db.product.findFirstOrThrow({ where: { status: "ACTIVE" } });
    const design = await db.design.create({
      data: { customerId: ava.id, productId: product.id, spec: {}, startedFrom: "PHOTO", referencePhotoKey: reference.key, status: "SAVED" },
    });
    await expect(requestQuote(db, storage, ava, { designId: design.id, notes: "" })).rejects.toBeInstanceOf(QuoteError);
  });

  it("refuses a photo with a brand logo, and one with no garment in it, leaving nothing behind", async () => {
    const ava = await createUser();
    const logo = await sharp({ create: { width: 500, height: 700, channels: 3, background: FAKE_LOGO_MARKER } }).jpeg().toBuffer();
    expect((await ownDress(ava, false, logo)).status).toEqual({ state: "failed", message: BRAND_LOGO_MESSAGE, code: "BRAND_LOGO" });
    const blank = await sharp({ create: { width: 500, height: 700, channels: 3, background: "#d8d4cf" } }).jpeg().toBuffer();
    const nothing = await ownDress(ava, false, blank);
    expect(nothing.status).toMatchObject({ state: "failed", code: "GARMENT_NOT_FOUND" });
    expect(await db.product.count({ where: { status: "PRIVATE" } })).toBe(0);
    expect(await db.design.count()).toBe(0);
  });

  it("stays private (with no owner) if the account is deleted", async () => {
    const ava = await createUser();
    const { productId } = await built(ava);
    await db.design.deleteMany({ where: { customerId: ava.id } });
    await db.user.delete({ where: { id: ava.id } });
    expect(await db.product.findUniqueOrThrow({ where: { id: productId } })).toMatchObject({ status: "PRIVATE", ownerId: null });
    expect(await loadDesignContext(db, storage, productId)).toBeNull();
  });

  it("from a drawing: an AI makes a realistic picture of it first, and the sketch stays the reference", async () => {
    const ava = await createUser();
    const notes: (string | null)[] = [];
    const fake = new FakeSketch();
    const renderer: SketchRenderer = { name: "test", renderSketch: (image, note, signal) => (notes.push(note), fake.renderSketch(image, note, signal)) };
    const { status, referenceKey } = await ownDress(ava, true, await sketchDrawing(), { garmentType: "dress", sketch: { note: "Red silk <b>!", renderer } });
    if (status.state !== "done") throw new Error(`expected done, got ${JSON.stringify(status)}`);
    // The note reached the renderer cleaned (plain words only).
    expect(notes).toEqual(["Red silk b"]);
    const product = await db.product.findUniqueOrThrow({ where: { id: status.result.productId }, include: { template: true } });
    expect(product).toMatchObject({ status: "PRIVATE", ownerId: ava.id, garmentType: "dress" });
    expect(product.description).toContain("AI rendering of the customer's sketch");
    expect(product.template).not.toBeNull();
    // The team makes what the sketch shows: it's the design's reference picture.
    expect(await db.design.findUniqueOrThrow({ where: { id: status.result.designId } })).toMatchObject({ referencePhotoKey: referenceKey, status: "SAVED", referenceIsDrawing: true });
    // Its quote says "drawing" too.
    const { quoteId } = await requestQuote(db, storage, ava, { designId: status.result.designId, notes: "" });
    expect(await db.quoteRequest.findUniqueOrThrow({ where: { id: quoteId } })).toMatchObject({ referenceIsDrawing: true });
  });

  it("from a drawing the AI can't render: a clear message, and nothing left behind", async () => {
    const ava = await createUser();
    const refusing: SketchRenderer = { name: "test", renderSketch: async () => null };
    const { status } = await ownDress(ava, false, await sketchDrawing(), { sketch: { renderer: refusing } });
    expect(status).toMatchObject({ state: "failed", code: "SKETCH_NOT_RENDERED", message: expect.stringContaining("drawing") });
    expect(await db.product.count({ where: { status: "PRIVATE" } })).toBe(0);
    expect(await db.design.count()).toBe(0);
  });

  it("refuses a brand name in a drawing's note", async () => {
    const ava = await createUser();
    const reference = await uploadReferencePhoto(storage, ava, await sketchDrawing());
    await expect(startDesignFrom(db, storage, ava, { mode: "own", referenceKey: reference.key, garmentType: "dress", exact: false, sketch: true, note: "Like a Gucci gown" })).rejects.toMatchObject({
      code: "BRAND_LOGO",
    });
    await expect(startDesignFrom(db, storage, ava, { mode: "own", referenceKey: reference.key, garmentType: "dress", exact: false, sketch: true, note: "x".repeat(201) })).rejects.toBeInstanceOf(AiError);
  });

  it("from a drawing, in two steps: three pictures to pick from, then the picked one becomes the dress", async () => {
    const ava = await createUser();
    const variants: (number | undefined)[] = [];
    const fake = new FakeSketch();
    const renderer: SketchRenderer = { name: "test", renderSketch: (image, note, signal, variant) => (variants.push(variant), fake.renderSketch(image, note, signal, variant)) };
    const drawing = await uploadReferencePhoto(storage, ava, await sketchDrawing());

    const first = await startDesignFrom(db, storage, ava, { mode: "sketch", referenceKey: drawing.key, note: "Navy linen" });
    await processNextJob(deps(undefined, undefined, renderer));
    const rendered = await getStartStatus(db, storage, ava, first.jobId);
    if (rendered.state !== "rendered") throw new Error(`expected renderings, got ${JSON.stringify(rendered)}`);
    expect(rendered.renders).toHaveLength(3);
    expect(variants).toEqual([0, 1, 2]);
    for (const render of rendered.renders) expect(render.key).toMatch(new RegExp(`^${ava.id}/sketch-renders/`));
    // The same drawing and note give the same pictures; "show me three more" makes a new set.
    expect((await startDesignFrom(db, storage, ava, { mode: "sketch", referenceKey: drawing.key, note: "Navy linen" })).cached).toBe(true);
    const more = await startDesignFrom(db, storage, ava, { mode: "sketch", referenceKey: drawing.key, note: "Navy linen", round: 1 });
    expect(more.cached).toBe(false);
    await processNextJob(deps(undefined, undefined, renderer));
    expect(variants).toEqual([0, 1, 2, 3, 4, 5]);

    // The picked picture is built as it is: no rendering again.
    const picked = rendered.renders[1]?.key ?? "";
    const built = await startDesignFrom(db, storage, ava, { mode: "own", referenceKey: drawing.key, garmentType: "dress", exact: false, sketch: true, note: "Navy linen", renderKey: picked });
    await processNextJob(deps(undefined, undefined, renderer));
    const status = await getStartStatus(db, storage, ava, built.jobId);
    if (status.state !== "done") throw new Error(`expected done, got ${JSON.stringify(status)}`);
    expect(variants).toHaveLength(6);
    const product = await db.product.findUniqueOrThrow({ where: { id: status.result.productId } });
    expect(product.description).toContain("AI rendering of the customer's sketch");
    expect(await db.design.findUniqueOrThrow({ where: { id: status.result.designId } })).toMatchObject({ referencePhotoKey: drawing.key, status: "DRAFT", referenceIsDrawing: true });
  });

  it("a drawing's pictures are only its owner's to pick, and none at all is a clear message", async () => {
    const ava = await createUser();
    const bob = await createUser();
    const drawing = await uploadReferencePhoto(storage, ava, await sketchDrawing());
    const job = await startDesignFrom(db, storage, ava, { mode: "sketch", referenceKey: drawing.key });
    await processNextJob(deps());
    const rendered = await getStartStatus(db, storage, ava, job.jobId);
    if (rendered.state !== "rendered") throw new Error("expected renderings");
    const bobsDrawing = await uploadReferencePhoto(storage, bob, await sketchDrawing());
    await expect(
      startDesignFrom(db, storage, bob, { mode: "own", referenceKey: bobsDrawing.key, garmentType: "dress", exact: true, sketch: true, renderKey: rendered.renders[0]?.key }),
    ).rejects.toMatchObject({ code: "INVALID" });

    const refusing: SketchRenderer = { name: "test", renderSketch: async () => null };
    const nothing = await startDesignFrom(db, storage, ava, { mode: "sketch", referenceKey: drawing.key, note: "Red silk" });
    await processNextJob(deps(undefined, undefined, refusing));
    expect(await getStartStatus(db, storage, ava, nothing.jobId)).toMatchObject({ state: "failed", code: "SKETCH_NOT_RENDERED" });
    // Only the first set's three pictures are stored.
    expect([...storage.objects.keys()].filter((id) => id.includes(`${ava.id}/sketch-renders/`))).toHaveLength(3);
  });
});
