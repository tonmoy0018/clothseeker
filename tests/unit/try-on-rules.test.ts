import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { AiProviderError } from "@/lib/ai/errors";
import { FakePlanner, FakeTryOn } from "@/lib/ai/fake";
import { GARMENT_CANVAS, prepareGarment } from "@/lib/ai/image-utils";
import { firstFileUrl, HuggingFaceTryOn, isQuotaError, type GradioConnect } from "@/lib/ai/tryon-hf";
import type { TryOnRequest } from "@/lib/ai/types";
import { consentSchema, designSignature, isTryOnStale, photoShapeProblem, productSignature, TRYON_CONSENT_POINTS } from "@/lib/tryon/rules";

import { validSpec } from "../fixtures/design";

const signal = new AbortController().signal;

describe("try-on rules", () => {
  it("consent must be an explicit yes", () => {
    expect(consentSchema.safeParse("yes").success).toBe(true);
    for (const value of [undefined, "", "no", true, "on", "YES"]) {
      expect(consentSchema.safeParse(value).success).toBe(false);
    }
    expect(TRYON_CONSENT_POINTS.join(" ")).toMatch(/third-party AI service/);
    expect(TRYON_CONSENT_POINTS.join(" ")).toMatch(/never uses your photos to train AI/);
    expect(TRYON_CONSENT_POINTS.join(" ")).toMatch(/deleted after 24 hours/);
  });

  it("a design edit makes a try-on stale; size and key order don't", () => {
    const spec = validSpec();
    const tried = designSignature(spec);
    const resized = validSpec({ size: "L" });
    expect(isTryOnStale(tried, resized)).toBe(false);
    const reordered = { ...spec, parts: Object.fromEntries(Object.entries(spec.parts).reverse()) };
    expect(isTryOnStale(tried, reordered)).toBe(false);
    expect(isTryOnStale(tried, { ...spec, parts: { ...spec.parts, skirt: { color: "#1b1b1b" } } })).toBe(true);
    expect(isTryOnStale(tried, { ...spec, styleOptions: { ...spec.styleOptions, neckline: "round" } })).toBe(true);
    expect(isTryOnStale(tried, { ...spec, layers: spec.layers.slice(1) })).toBe(true);
    expect(productSignature("a", "k1")).not.toBe(productSignature("a", "k2"));
  });

  it("checks photo shape and light at upload", () => {
    expect(photoShapeProblem({ width: 600, height: 900, meanBrightness: 120 })).toBeNull();
    expect(photoShapeProblem({ width: 900, height: 600, meanBrightness: 120 })).toMatch(/portrait/);
    expect(photoShapeProblem({ width: 600, height: 900, meanBrightness: 20 })).toMatch(/too dark/);
    expect(photoShapeProblem({ width: 600, height: 900, meanBrightness: 250 })).toMatch(/too bright/);
  });
});

async function grey(width: number, height: number, level: number) {
  return sharp({ create: { width, height, channels: 3, background: { r: level, g: level, b: level } } }).webp().toBuffer();
}

describe("garment preparation and fakes", () => {
  it("puts the garment on a white 3:4 canvas", async () => {
    const garment = await sharp({ create: { width: 300, height: 500, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: await sharp({ create: { width: 120, height: 300, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 1 } } }).png().toBuffer(), left: 90, top: 100 }])
      .png()
      .toBuffer();
    const prepared = await prepareGarment(garment);
    const meta = await sharp(prepared).metadata();
    expect({ width: meta.width, height: meta.height }).toEqual(GARMENT_CANVAS);
    const { data } = await sharp(prepared).raw().toBuffer({ resolveWithObject: true });
    expect([data[0], data[1], data[2]]).toEqual([255, 255, 255]);
  });

  it("the fake photo check rejects dark and landscape photos", async () => {
    const planner = new FakePlanner();
    expect(await planner.checkTryOnPhoto({ data: await grey(600, 900, 140), mimeType: "image/webp" }, signal)).toEqual({ onePerson: true, facingForward: true, goodLight: true, bodyVisible: true });
    expect((await planner.checkTryOnPhoto({ data: await grey(600, 900, 30), mimeType: "image/webp" }, signal)).goodLight).toBe(false);
    expect((await planner.checkTryOnPhoto({ data: await grey(900, 600, 140), mimeType: "image/webp" }, signal)).bodyVisible).toBe(false);
  });

  it("the fake try-on is deterministic and keeps the photo size", async () => {
    const request: TryOnRequest = { person: { data: await grey(600, 900, 140), mimeType: "image/webp" }, garment: { data: await prepareGarment(await grey(300, 400, 90)), mimeType: "image/png" } };
    const a = await new FakeTryOn().tryOn(request, signal);
    expect((await new FakeTryOn().tryOn(request, signal)).equals(a)).toBe(true);
    expect(await sharp(a).metadata()).toMatchObject({ width: 600, height: 900 });
  });
});

describe("HuggingFaceTryOn", () => {
  const request = async (): Promise<TryOnRequest> => ({
    person: { data: await grey(600, 900, 140), mimeType: "image/webp" },
    garment: { data: await grey(768, 1024, 255), mimeType: "image/png" },
  });

  function spaces(behaviour: Record<string, () => Promise<{ data: unknown }>>) {
    const calls: { space: string; endpoint: string; data: Record<string, unknown>; token: string | undefined }[] = [];
    const connect: GradioConnect = async (space, token) => ({
      predict: async (endpoint, data) => {
        calls.push({ space, endpoint, data, token });
        const run = behaviour[space];
        if (!run) throw new Error("unknown space");
        return run();
      },
    });
    return { connect, calls };
  }

  const image = Buffer.from("result-image");
  const fetchOk = async () => new Response(new Uint8Array(image));

  it("asks for the dress mode and downloads the result", async () => {
    const { connect, calls } = spaces({ "levihsu/OOTDiffusion": async () => ({ data: [[{ image: { url: "https://levihsu-ootdiffusion.hf.space/file=out.webp" }, caption: null }]] }) });
    const provider = new HuggingFaceTryOn({ spaces: ["levihsu/OOTDiffusion", "franciszzj/Leffa"], token: "hf_abcdefghijklmnopqrstuvwxyz", connect, fetch: fetchOk });
    expect((await provider.tryOn(await request(), signal)).equals(image)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ endpoint: "/process_dc", data: { category: "Dress" }, token: "hf_abcdefghijklmnopqrstuvwxyz" });
  });

  it("falls back to the next space, using Leffa's dress mode", async () => {
    const { connect, calls } = spaces({
      "levihsu/OOTDiffusion": async () => {
        throw new Error("Space is sleeping");
      },
      "franciszzj/Leffa": async () => ({ data: [{ url: "https://franciszzj-leffa.hf.space/file=out.webp" }, null, null] }),
    });
    const provider = new HuggingFaceTryOn({ spaces: ["levihsu/OOTDiffusion", "franciszzj/Leffa"], connect, fetch: fetchOk });
    await provider.tryOn(await request(), signal);
    expect(calls.map((c) => c.space)).toEqual(["levihsu/OOTDiffusion", "franciszzj/Leffa"]);
    expect(calls[1]?.data).toMatchObject({ vt_model_type: "dress_code", vt_garment_type: "dresses", ref_acceleration: false });
    expect(calls[1]?.token).toBeUndefined();
  });

  it("reports the daily GPU limit when every space is over quota, otherwise a retryable failure", async () => {
    const quota = async () => {
      throw new Error("You have exceeded your ZeroGPU quota (180s requested vs. 168s left).");
    };
    const overQuota = new HuggingFaceTryOn({ spaces: ["levihsu/OOTDiffusion", "franciszzj/Leffa"], connect: spaces({ "levihsu/OOTDiffusion": quota, "franciszzj/Leffa": quota }).connect, fetch: fetchOk });
    await expect(overQuota.tryOn(await request(), signal)).rejects.toMatchObject({ code: "TRYON_LIMIT", retryable: false });

    const mixed = new HuggingFaceTryOn({
      spaces: ["levihsu/OOTDiffusion", "franciszzj/Leffa"],
      connect: spaces({ "levihsu/OOTDiffusion": quota, "franciszzj/Leffa": async () => ({ data: [] }) }).connect,
      fetch: fetchOk,
    });
    const error = await mixed.tryOn(await request(), signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    expect(error).toMatchObject({ code: "PROVIDER", retryable: true });
    // Space errors may echo inputs: they never reach our error message.
    expect(error instanceof Error && error.message).not.toMatch(/ZeroGPU|168s/);
  });

  it("stops when the job is aborted", async () => {
    const controller = new AbortController();
    const provider = new HuggingFaceTryOn({ spaces: ["levihsu/OOTDiffusion"], connect: spaces({ "levihsu/OOTDiffusion": () => new Promise(() => undefined) }).connect, fetch: fetchOk });
    const pending = provider.tryOn(await request(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT", retryable: true });
  });

  it("finds result URLs and quota errors", () => {
    expect(firstFileUrl([[{ image: { url: "https://x.hf.space/a.webp" } }]])).toBe("https://x.hf.space/a.webp");
    expect(firstFileUrl([{ url: "http://insecure/a.webp" }])).toBeNull();
    expect(isQuotaError(new Error("You have exceeded your GPU quota"))).toBe(true);
    expect(isQuotaError(new Error("Space is sleeping"))).toBe(false);
  });
});
