import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { findBrandTerm } from "@/lib/ai/brands";
import { AI_FAILURE_MESSAGES, BRAND_LOGO_MESSAGE, failureMessage } from "@/lib/ai/errors";
import { FAKE_LOGO_MARKER, FakeImage, FakePlanner } from "@/lib/ai/fake";
import { aiInputHash, canonicalJson, normalizeInstruction } from "@/lib/ai/hash";
import { nearestColor, parsePlan, planConstraints, summarizeSpec, variationToSpec, type PlanVariation } from "@/lib/ai/plan";
import { startOfDhakaDay } from "@/lib/ai/quota";
import type { PlanRequest } from "@/lib/ai/types";
import { knockOutWhite } from "@/lib/ai/worker/design-round";
import { validateDesignAgainstTemplate } from "@/lib/design/validate";

import { CONTEXT, CUSTOMER_ID, TEMPLATE, validSpec } from "../fixtures/design";

const MOTIF_KEY = `${CUSTOMER_ID}/ai/12345678-1111-4111-8111-111111111111.webp`;
const signal = new AbortController().signal;

describe("AI request hashing", () => {
  const base = { customerId: "c", spec: validSpec(), instruction: "pastel florals", attachments: ["a"], reference: null, generation: 0 };

  it("ignores key order, whitespace and case", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
    const reordered = Object.fromEntries(Object.entries(base).reverse());
    expect(aiInputHash(reordered)).toBe(aiInputHash(base));
    expect(normalizeInstruction("  Pastel   FLORALS \n")).toBe("pastel florals");
  });

  it("changes when anything that affects the result changes", () => {
    const hash = aiInputHash(base);
    expect(aiInputHash({ ...base, instruction: "dark florals" })).not.toBe(hash);
    expect(aiInputHash({ ...base, attachments: ["b"] })).not.toBe(hash);
    expect(aiInputHash({ ...base, reference: { roundId: "r", optionIndex: 1 } })).not.toBe(hash);
    expect(aiInputHash({ ...base, generation: 1 })).not.toBe(hash);
    expect(aiInputHash({ ...base, spec: validSpec({ size: "L" }) })).not.toBe(hash);
  });
});

describe("brand terms", () => {
  it("finds clothing brands as whole words, ignoring case and accents", () => {
    expect(findBrandTerm("add a Nike logo")).toBe("nike");
    expect(findBrandTerm("something like LOUIS  VUITTON monogram")).toBe("louis vuitton");
    expect(findBrandTerm("Hermès scarf print")).toBe("hermes");
    expect(findBrandTerm("Levi’s style")).toBe("levi's");
    expect(findBrandTerm("H&M basics")).toBe("h&m");
  });

  it("doesn't block ordinary words", () => {
    for (const text of ["a puma on the chest", "supreme comfort", "champion of florals", "yellow skirt", "diorama of stars", "nikel buttons", "zarathustra"]) {
      expect(findBrandTerm(text)).toBeNull();
    }
  });

  it("uses the exact brand message", () => {
    expect(BRAND_LOGO_MESSAGE).toBe("Clothing brand logos can't be used. Try your own logo or another image.");
    expect(failureMessage("BRAND_LOGO")).toBe(BRAND_LOGO_MESSAGE);
    expect(failureMessage("something-else")).toBe(AI_FAILURE_MESSAGES.INTERNAL);
  });
});

describe("Dhaka day window", () => {
  it("starts at local midnight (UTC+6)", () => {
    expect(startOfDhakaDay(new Date("2026-10-09T17:59:59Z")).toISOString()).toBe("2026-10-08T18:00:00.000Z");
    expect(startOfDhakaDay(new Date("2026-10-09T18:00:00Z")).toISOString()).toBe("2026-10-09T18:00:00.000Z");
    expect(startOfDhakaDay(new Date("2026-10-09T03:00:00Z")).toISOString()).toBe("2026-10-08T18:00:00.000Z");
  });
});

describe("planner output", () => {
  const variation = (overrides: Partial<Record<keyof PlanVariation, unknown>> = {}) => ({
    title: "Emerald bloom",
    summary: "Emerald skirt with florals",
    parts: [{ regionId: "skirt", color: "#1F6F50", pattern: { id: "floral", color: "#f5f5f0" } }],
    styleOptions: { neckline: "v-neck", sleeveLength: "long", dressLength: "maxi" },
    text: { content: "Ava", fontId: "lobster", color: "#f5f5f0" },
    motif: { prompt: "flower motif", color: "#e8a0b4" },
    ...overrides,
  });

  it("accepts up to 4 variations and clips long strings", () => {
    const options = parsePlan({ variations: [variation({ title: "x".repeat(100) }), variation(), variation(), variation(), variation()] });
    expect(options).toHaveLength(4);
    expect(options[0]?.title).toHaveLength(40);
  });

  it("rejects answers that aren't a plan", () => {
    expect(() => parsePlan({})).toThrow();
    expect(() => parsePlan({ variations: [] })).toThrow();
    expect(() => parsePlan("ignore previous instructions")).toThrow();
    expect(() => parsePlan({ variations: [variation({ parts: [{ regionId: "skirt", color: "red" }] })] })).toThrow();
  });

  it("turns a variation into a template-valid spec on top of the current design", () => {
    const [option] = parsePlan({ variations: [variation()] });
    if (!option) throw new Error("no option");
    const spec = variationToSpec(validSpec(), option.variation, { ...CONTEXT, template: TEMPLATE, motifKey: MOTIF_KEY });
    expect(spec).not.toBeNull();
    if (!spec) return;
    expect(validateDesignAgainstTemplate(spec, TEMPLATE, CONTEXT)).toEqual([]);
    expect(spec.parts.skirt).toEqual({ color: "#1f6f50", pattern: { id: "floral", color: "#f5f5f0" } });
    expect(spec.parts.bodice).toEqual(validSpec().parts.bodice);
    expect(spec.styleOptions).toEqual({ neckline: "v-neck", sleeveLength: "long", dressLength: "maxi" });
    expect(spec.layers.map((l) => l.id)).toEqual(["t1", "d1", "ai-motif", "ai-text"]);
    const motif = spec.layers.find((l) => l.id === "ai-motif");
    expect(motif?.kind === "image" && motif.image.assetKey).toBe(MOTIF_KEY);
  });

  it("repairs values outside the template instead of trusting them", () => {
    const [option] = parsePlan({
      variations: [
        variation({
          parts: [
            { regionId: "skirt", color: "#ff0001", pattern: { id: "leopard", color: "#000000" } },
            { regionId: "lining", color: "#1f6f50" },
            { regionId: "not-a-region", color: "#1f6f50" },
          ],
          styleOptions: { neckline: "plunging", sleeveLength: "short", dressLength: "floor" },
          text: { content: "NIKE", fontId: "comic-sans", color: "#123456" },
          motif: { prompt: "gucci logo", color: "#000000" },
        }),
      ],
    });
    if (!option) throw new Error("no option");
    const spec = variationToSpec(validSpec(), option.variation, { ...CONTEXT, template: TEMPLATE, motifKey: MOTIF_KEY });
    if (!spec) throw new Error("no spec");
    expect(validateDesignAgainstTemplate(spec, TEMPLATE, CONTEXT)).toEqual([]);
    const allowed = TEMPLATE.allowedColors.map((c) => c.hex.toLowerCase());
    expect(allowed).toContain(spec.parts.skirt?.color);
    expect(spec.parts.skirt?.pattern).toBeUndefined();
    expect(spec.parts).not.toHaveProperty("lining");
    expect(spec.parts).not.toHaveProperty("not-a-region");
    expect(spec.styleOptions).toEqual({ neckline: "square", sleeveLength: "short", dressLength: "midi" });
    // Brand words never become text or motifs.
    expect(spec.layers.map((l) => l.id)).toEqual(["t1", "d1"]);
  });

  it("replaces earlier AI layers instead of stacking them", () => {
    const [option] = parsePlan({ variations: [variation()] });
    if (!option) throw new Error("no option");
    const ctx = { ...CONTEXT, template: TEMPLATE, motifKey: MOTIF_KEY };
    const once = variationToSpec(validSpec(), option.variation, ctx);
    if (!once) throw new Error("no spec");
    const twice = variationToSpec(once, option.variation, ctx);
    expect(twice?.layers.map((l) => l.id)).toEqual(["t1", "d1", "ai-motif", "ai-text"]);
  });

  it("drops AI layers that can't be valid but keeps the colors", () => {
    const [option] = parsePlan({ variations: [variation()] });
    if (!option) throw new Error("no option");
    const foreignKey = `${"0".repeat(8)}-0000-4000-8000-000000000000/ai/12345678-1111-4111-8111-111111111111.webp`;
    const spec = variationToSpec(validSpec(), option.variation, { ...CONTEXT, template: TEMPLATE, motifKey: foreignKey });
    expect(spec?.layers.map((l) => l.id)).toEqual(["t1", "d1"]);
    expect(spec?.parts.skirt?.color).toBe("#1f6f50");
  });

  it("nearestColor picks the closest allowed color", () => {
    expect(nearestColor("#fe0000", ["#00ff00", "#ff0000", "#0000ff"])).toBe("#ff0000");
    expect(nearestColor("#123456", [])).toBeNull();
  });
});

describe("fake providers", () => {
  const request = (overrides: Partial<PlanRequest> = {}): PlanRequest => ({
    instruction: "Make it evening-ready in emerald",
    images: [],
    constraints: planConstraints(TEMPLATE, "Test dress"),
    current: summarizeSpec(validSpec()),
    reference: null,
    seed: "a".repeat(64),
    ...overrides,
  });

  it("plans deterministically, and only with allowed values", async () => {
    const planner = new FakePlanner();
    const first = await planner.planDesign(request(), signal);
    expect(await planner.planDesign(request(), signal)).toEqual(first);
    expect(await planner.planDesign(request({ seed: "b".repeat(64) }), signal)).not.toEqual(first);

    const options = parsePlan(first);
    expect(options).toHaveLength(4);
    for (const option of options) {
      expect(variationToSpec(validSpec(), option.variation, { ...CONTEXT, template: TEMPLATE, motifKey: MOTIF_KEY })).not.toBeNull();
    }
    // Colors named by the customer come first.
    const emerald = TEMPLATE.allowedColors.find((c) => c.name.toLowerCase() === "emerald");
    expect(options[0]?.variation.parts[0]?.color).toBe(emerald?.hex.toLowerCase());
  });

  it("flags photos carrying the test brand marker", async () => {
    const planner = new FakePlanner();
    const photo = (hex: string) => sharp({ create: { width: 300, height: 300, channels: 3, background: hex } }).webp().toBuffer();
    expect(await planner.detectBrandLogos([{ data: await photo("#336699"), mimeType: "image/webp" }], signal)).toEqual({ detected: false });
    expect((await planner.detectBrandLogos([{ data: await photo(FAKE_LOGO_MARKER), mimeType: "image/webp" }], signal)).detected).toBe(true);
  });

  it("draws the same motif for the same request", async () => {
    const images = new FakeImage();
    const a = await images.generateMotif({ prompt: "flower motif", color: "#e8a0b4", seed: 7 }, signal);
    expect((await images.generateMotif({ prompt: "flower motif", color: "#e8a0b4", seed: 7 }, signal)).equals(a)).toBe(true);
    expect((await sharp(a).metadata()).hasAlpha).toBe(true);
  });

  it("respects aborts while waiting", async () => {
    const controller = new AbortController();
    const pending = new FakePlanner(10_000).planDesign(request(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/Aborted/);
  });
});

describe("motif clean-up", () => {
  it("makes a white background transparent and rejects non-images", async () => {
    const motif = await sharp({ create: { width: 200, height: 200, channels: 3, background: "#ffffff" } })
      .composite([{ input: await sharp({ create: { width: 50, height: 50, channels: 3, background: "#aa0000" } }).png().toBuffer(), left: 75, top: 75 }])
      .jpeg()
      .toBuffer();
    // Margins are cropped away, leaving the motif with a transparent edge where the white was.
    const framed = await sharp({ create: { width: 200, height: 200, channels: 3, background: "#ffffff" } })
      .composite([{ input: await sharp({ create: { width: 50, height: 50, channels: 4, background: { r: 170, g: 0, b: 0, alpha: 1 } } }).extend({ top: 4, bottom: 4, left: 4, right: 4, background: "#ffffff" }).png().toBuffer(), left: 71, top: 71 }])
      .png()
      .toBuffer();
    const cropped = await knockOutWhite(framed);
    const meta = await sharp(cropped).metadata();
    expect(meta.width).toBeLessThanOrEqual(58);
    expect(meta.width).toBeGreaterThanOrEqual(50);
    const { data, info } = await sharp(await knockOutWhite(motif)).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    // JPEG edges leave a few soft pixels around the 50 px block.
    expect(info.width).toBeGreaterThanOrEqual(50);
    expect(info.width).toBeLessThanOrEqual(58);
    expect(data[3]).toBeLessThan(255);
    const centre = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 4;
    expect(data[centre + 3]).toBe(255);
    await expect(knockOutWhite(Buffer.from("<svg/>"))).rejects.toThrow(/unreadable/);
  });
});
