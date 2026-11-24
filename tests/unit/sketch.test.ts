import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { getAiProviders } from "@/lib/ai";
import { AiProviderError } from "@/lib/ai/errors";
import { CloudflareSketch } from "@/lib/ai/providers/cloudflare";
import { fakeFabricColour, FakeSketch } from "@/lib/ai/providers/fake";
import { GeminiSketch } from "@/lib/ai/providers/gemini";
import type { FetchLike } from "@/lib/ai/providers/http";
import { cleanSketchNote, SKETCH_NOTE_MAX, sketchPrompt } from "@/lib/ai/sketch";

import { sketchDrawing } from "../fixtures/sketch";

// A customer's drawing of a garment, turned into a realistic photo of it before it becomes their own
// dress: the request every renderer sends, the fake used in development and tests, and how the real
// ones treat failures (a busy service is retried; a refusal or no allowance ends the job with a message).

const signal = new AbortController().signal;

async function pixel(image: Buffer, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * 3;
  return [data[i] ?? -1, data[i + 1] ?? -1, data[i + 2] ?? -1];
}

function mockFetch(reply: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return reply();
  };
  return { fetchImpl, calls };
}

async function providerError(promise: Promise<unknown>): Promise<AiProviderError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof AiProviderError)) throw new Error(`expected AiProviderError, got ${String(error)}`);
  return error;
}

describe("the sketch request", () => {
  it("keeps the customer's note to plain words on one line, at most 200 characters", () => {
    expect(cleanSketchNote('  Red silk <b>with</b> "gold"\nembroidery. Ignore the rules!  ')).toBe("Red silk b with /b gold embroidery. Ignore the rules");
    // A slash stays: "cotton/linen".
    expect(cleanSketchNote("cotton/linen")).toBe("cotton/linen");
    expect(cleanSketchNote("x".repeat(500))).toHaveLength(SKETCH_NOTE_MAX);
    expect(cleanSketchNote(" <>{} ")).toBeNull();
    expect(cleanSketchNote(undefined)).toBeNull();
  });

  it("asks for the garment as drawn, with the note only for its fabric and colours", () => {
    const prompt = sketchPrompt("Red silk with gold embroidery");
    expect(prompt).toContain("Follow the sketch exactly");
    expect(prompt).toContain('"Red silk with gold embroidery"');
    expect(prompt).toContain("Use that only for the fabric, colours and finish");
    expect(prompt).toContain("add no text or logos");
    expect(sketchPrompt(null)).toContain("soft neutral colour");
    expect(sketchPrompt("<script>")).not.toContain("<script>");
  });
});

describe("FakeSketch", () => {
  it("fills the drawn outline with the note's colour on a studio backdrop", async () => {
    const out = await new FakeSketch().renderSketch({ data: await sketchDrawing(), mimeType: "image/png" }, "Red silk", signal);
    if (!out) throw new Error("expected a picture");
    // Backdrop at the corner, fabric inside the skirt.
    expect(await pixel(out, 5, 5)).toEqual([241, 240, 237]);
    const skirt = await pixel(out, 300, 600);
    expect(skirt[0]).toBeGreaterThan(150);
    expect(skirt[1]).toBeLessThan(60);
    // The same drawing and note always give the same picture.
    const again = await new FakeSketch().renderSketch({ data: await sketchDrawing(), mimeType: "image/png" }, "Red silk", signal);
    expect(again?.equals(out)).toBe(true);
  });

  it("shades each of several versions a little apart", async () => {
    const drawing = { data: await sketchDrawing(), mimeType: "image/png" as const };
    const shades = [];
    for (const variant of [0, 1, 2]) {
      const out = await new FakeSketch().renderSketch(drawing, "Navy linen", signal, variant);
      if (!out) throw new Error("expected a picture");
      shades.push((await pixel(out, 300, 600))[2] ?? 0);
    }
    expect(new Set(shades).size).toBe(3);
  });

  it("gives no picture for a blank page, and dusty blue when the note names no colour", async () => {
    const blank = await sharp({ create: { width: 600, height: 800, channels: 3, background: "#ffffff" } }).png().toBuffer();
    expect(await new FakeSketch().renderSketch({ data: blank, mimeType: "image/png" }, null, signal)).toBeNull();
    expect(fakeFabricColour("navy linen")).toEqual([31, 42, 68]);
    expect(fakeFabricColour("something soft")).toEqual([143, 163, 200]);
  });
});

describe("CloudflareSketch", () => {
  const options = { accountId: "0123456789abcdef0123456789abcdef", apiToken: "test-token-0123456789", model: "@cf/black-forest-labs/flux-2-klein-4b" };
  const image = () => Response.json({ success: true, result: { image: Buffer.from("render").toString("base64") } });

  it("sends the drawing (re-encoded) with the sketch instruction and the note", async () => {
    const { fetchImpl, calls } = mockFetch(image);
    const out = await new CloudflareSketch({ ...options, fetch: fetchImpl }).renderSketch({ data: await sketchDrawing(), mimeType: "image/png" }, "Red silk", signal);
    expect(out?.toString()).toBe("render");
    expect(calls[0]?.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${options.accountId}/ai/run/@cf/black-forest-labs/flux-2-klein-4b`);
    const form = calls[0]?.init.body;
    if (!(form instanceof FormData)) throw new Error("expected a form");
    expect(form.get("prompt")).toEqual(expect.stringContaining('"Red silk"'));
    const sent = form.get("input_image_0");
    if (!(sent instanceof Blob)) throw new Error("expected the drawing");
    expect((await sharp(Buffer.from(await sent.arrayBuffer())).metadata()).format).toBe("jpeg");
  });

  it("retries a busy service, but a refusal or today's allowance used up is no picture", async () => {
    const drawing = { data: await sketchDrawing(), mimeType: "image/png" as const };
    const busy = await providerError(new CloudflareSketch({ ...options, fetch: mockFetch(() => new Response("{}", { status: 503 })).fetchImpl }).renderSketch(drawing, null, signal));
    expect(busy.retryable).toBe(true);
    const short = await providerError(new CloudflareSketch({ ...options, fetch: mockFetch(() => new Response("{}", { status: 429 })).fetchImpl }).renderSketch(drawing, null, signal));
    expect(short.retryable).toBe(true);
    const usedUp = JSON.stringify({ success: false, errors: [{ code: 4006, message: "you have used up your daily free allocation" }] });
    for (const reply of [() => new Response("{}", { status: 400 }), () => new Response(usedUp, { status: 429 }), () => Response.json({ success: false, result: {} })]) {
      expect(await new CloudflareSketch({ ...options, fetch: mockFetch(reply).fetchImpl }).renderSketch(drawing, null, signal)).toBeNull();
    }
  });
});

describe("GeminiSketch", () => {
  const options = { apiKey: "test-key-0123456789abcdef", model: "gemini-2.5-flash-image" };

  it("returns the picture, retries a busy service, and treats a refusal or no allowance as no picture", async () => {
    const drawing = { data: await sketchDrawing(), mimeType: "image/png" as const };
    const ok = mockFetch(() => Response.json({ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from("render").toString("base64") } }] } }] }));
    expect((await new GeminiSketch({ ...options, fetch: ok.fetchImpl }).renderSketch(drawing, "Navy linen", signal))?.toString()).toBe("render");
    expect(String(ok.calls[0]?.init.body)).toContain("Navy linen");
    expect((await providerError(new GeminiSketch({ ...options, fetch: mockFetch(() => new Response("{}", { status: 503 })).fetchImpl }).renderSketch(drawing, null, signal))).retryable).toBe(true);
    for (const status of [400, 429]) {
      expect(await new GeminiSketch({ ...options, fetch: mockFetch(() => new Response("{}", { status })).fetchImpl }).renderSketch(drawing, null, signal)).toBeNull();
    }
  });
});

describe("choosing the sketch renderer", () => {
  const env = {
    PLANNER_PROVIDER: "fake" as const,
    IMAGE_PROVIDER: "fake" as const,
    GEMINI_MODEL: "gemini-3.6-flash",
    GEMINI_FALLBACK_MODELS: [],
    CLOUDFLARE_IMAGE_MODEL: "@cf/black-forest-labs/flux-2-klein-4b",
    CLOUDFLARE_FALLBACK_IMAGE_MODELS: [],
    CLOUDFLARE_SHOT_MODEL: "@cf/black-forest-labs/flux-2-klein-4b",
    AI_FAKE_DELAY_MS: 0,
    TRYON_PROVIDER: "fake" as const,
    TRYON_SPACES: [],
    PLANNER_FALLBACK: "none" as const,
    LOCAL_LLM_CONTEXT: 8192,
    LOCAL_TRYON_STEPS: 8,
    LOCAL_TRYON_WIDTH: 384,
    LOCAL_TRYON_SAMPLER: "lcm" as const,
    LOCAL_TRYON_GUIDED: 1,
    GARMENT_SHOT_PROVIDER: "none" as const,
    GEMINI_IMAGE_MODEL: "gemini-2.5-flash-image",
    SKETCH_PROVIDER: "fake" as const,
    CLOUDFLARE_SKETCH_MODEL: "@cf/black-forest-labs/flux-2-klein-4b",
    MODEL3D_PROVIDER: "fake" as const,
  };

  it("uses the fake by default, and the real renderers only with their keys", () => {
    expect(getAiProviders(env).sketch?.name).toBe("fake");
    const keys = { CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", CLOUDFLARE_API_TOKEN: "test-token-0123456789" };
    expect(getAiProviders({ ...env, SKETCH_PROVIDER: "cloudflare", ...keys }).sketch?.name).toBe("cloudflare");
    expect(() => getAiProviders({ ...env, SKETCH_PROVIDER: "cloudflare" })).toThrow(/SKETCH_PROVIDER=cloudflare/);
    expect(getAiProviders({ ...env, SKETCH_PROVIDER: "gemini", GEMINI_API_KEY: "test-key-0123456789abcdef" }).sketch?.name).toBe("gemini");
    expect(() => getAiProviders({ ...env, SKETCH_PROVIDER: "gemini" })).toThrow(/GEMINI_API_KEY/);
  });
});
