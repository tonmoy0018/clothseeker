import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";

import { normalizeForRender } from "@/lib/design/normalize";
import { printPixels, renderFlatGarment, renderPreview, renderPrintFiles, storageAssets, type Assets } from "@/lib/renderer/render";
import { BUCKETS } from "@/lib/storage/buckets";

import { KEYS, TEMPLATE, storageWithTemplateAssets, validSpec } from "../fixtures/design";

// Set RENDER_SNAPSHOT_DIR=/some/dir to write the rendered images for a visual check.
const snapshotDir = process.env.RENDER_SNAPSHOT_DIR;
function snapshot(name: string, data: Buffer) {
  if (snapshotDir) {
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(path.join(snapshotDir, name), data);
  }
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function pixel(png: Buffer, x: number, y: number) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * 4;
  return { r: data[i] ?? 0, g: data[i + 1] ?? 0, b: data[i + 2] ?? 0, a: data[i + 3] ?? 0 };
}

let assets: Assets;

beforeAll(async () => {
  const storage = await storageWithTemplateAssets();
  const logo = await sharp({ create: { width: 400, height: 400, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 1 } } })
    .webp()
    .toBuffer();
  await storage.put(BUCKETS.designAssets, KEYS.upload, logo, "image/webp");
  assets = storageAssets(storage);
});

describe("renderPreview", () => {
  it("recolors masked regions with multiply and leaves the rest untouched", async () => {
    const preview = await renderPreview(normalizeForRender(validSpec(), TEMPLATE), "front", assets);
    snapshot("preview-front.png", preview);
    const meta = await sharp(preview).metadata();
    expect([meta.width, meta.height]).toEqual([1200, 1560]);

    // Bodice (solid emerald #1f6f50 × garment grey) below the chest print area.
    const bodice = await pixel(preview, 480, 580);
    expect(bodice.g).toBeGreaterThan(bodice.r + 40);
    expect(bodice.g).toBeLessThan(120);
    // Straps have no color in this design: still the neutral garment grey.
    const strap = await pixel(preview, 510, 150);
    expect(Math.abs(strap.r - strap.g)).toBeLessThan(6);
    expect(strap.r).toBeGreaterThan(200);
    // Outside the dress: the plain background.
    const background = await pixel(preview, 20, 20);
    for (const [channel, value] of [[background.r, 0xf3], [background.g, 0xf2], [background.b, 0xef]] as const) {
      expect(Math.abs(channel - value)).toBeLessThanOrEqual(2); // WebP rounding
    }
  });

  it("renders the back with its own masks", async () => {
    const preview = await renderPreview(normalizeForRender(validSpec({ parts: { skirt: { color: "#722f37" } } }), TEMPLATE), "back", assets);
    snapshot("preview-back.png", preview);
    const skirt = await pixel(preview, 600, 1200);
    expect(skirt.r).toBeGreaterThan(skirt.g + 30);
  });

  it("recolours photos with their own light and shade: even dark fabric takes a pale colour", async () => {
    // A dark navy "photo" garment with the same masks.
    const storage = await storageWithTemplateAssets();
    const navyKey = KEYS.front.replace("aaaaaaaa", "99999999");
    const navy = await sharp({ create: { width: 1200, height: 1560, channels: 3, background: "#1f2a44" } }).webp().toBuffer();
    await storage.put(BUCKETS.productMedia, navyKey, navy, "image/webp");
    const photo = { ...TEMPLATE, garmentImages: { ...TEMPLATE.garmentImages, front: navyKey } };
    const pink = validSpec({ parts: { bodice: { color: "#e8a0b4" } } });
    const shaded = await renderPreview(normalizeForRender(pink, { ...photo, recolor: "shade" }), "front", storageAssets(storage));
    const multiplied = await renderPreview(normalizeForRender(pink, photo), "front", storageAssets(storage));
    const [a, b] = [await pixel(shaded, 480, 580), await pixel(multiplied, 480, 580)];
    expect(a.r).toBeGreaterThan(180); // pale pink, lit by the photo
    expect(a.r).toBeGreaterThan(a.g);
    expect(b.r).toBeLessThan(60); // multiplying can't lighten navy
  });

  it("is deterministic: identical bytes for the same design", async () => {
    const plan = normalizeForRender(validSpec(), TEMPLATE);
    const [a, b] = await Promise.all([renderPreview(plan, "front", assets), renderPreview(plan, "front", assets)]);
    expect(sha(a)).toBe(sha(b));
  });
});

describe("renderFlatGarment", () => {
  it("cuts the garment out onto a transparent background", async () => {
    const flat = await renderFlatGarment(normalizeForRender(validSpec(), TEMPLATE), assets, [KEYS.strapsFront, KEYS.bodiceFront, KEYS.skirtFront]);
    snapshot("flat-garment.png", flat);
    expect((await pixel(flat, 20, 20)).a).toBe(0);
    expect((await pixel(flat, 600, 1200)).a).toBe(255);
  });
});

describe("renderPrintFiles", () => {
  it("produces one transparent 300 DPI PNG per area with layers, at real size", async () => {
    const [text] = validSpec().layers;
    if (!text) throw new Error("fixture");
    const spec = validSpec({
      layers: [
        ...validSpec().layers,
        { id: "i1", areaId: "front-skirt", kind: "image", x: 0.25, y: 0.25, w: 0.5, h: 0.5, rotation: 15, image: { assetKey: KEYS.upload } },
      ],
    });
    const files = await renderPrintFiles(normalizeForRender(spec, TEMPLATE), assets);
    expect(files.map((f) => f.areaId)).toEqual(["front-chest", "front-skirt"]);

    const chest = files[0];
    if (!chest) throw new Error("missing");
    snapshot("print-front-chest.png", chest.png);
    expect(printPixels(20, 15)).toEqual({ width: 2362, height: 1772 });
    const meta = await sharp(chest.png).metadata();
    expect([meta.width, meta.height, meta.density, meta.hasAlpha]).toEqual([2362, 1772, 300, true]);
    expect((await pixel(chest.png, 2, 2)).a).toBe(0);
    const stats = await sharp(chest.png).stats();
    expect(stats.channels[3]?.max).toBe(255); // something was drawn

    const skirt = files[1];
    if (!skirt) throw new Error("missing");
    snapshot("print-front-skirt.png", skirt.png);
    const centre = await pixel(skirt.png, Math.round(skirt.widthPx / 2), Math.round(skirt.heightPx / 2));
    // Uploads are stored as lossy WebP, so allow a little colour drift.
    expect(centre.a).toBe(255);
    for (const [actual, expected] of [[centre.r, 200], [centre.g, 40], [centre.b, 40]] as const) {
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(3);
    }
  });

  it("is deterministic", async () => {
    const plan = normalizeForRender(validSpec(), TEMPLATE);
    const [a, b] = await Promise.all([renderPrintFiles(plan, assets), renderPrintFiles(plan, assets)]);
    expect(a.map((f) => sha(f.png))).toEqual(b.map((f) => sha(f.png)));
  });

  it("fails clearly when an asset is missing", async () => {
    const spec = validSpec({
      layers: [{ id: "i1", areaId: "front-chest", kind: "image", x: 0, y: 0, w: 1, h: 1, rotation: 0, image: { assetKey: KEYS.upload.replace("12345678", "87654321") } }],
    });
    await expect(renderPrintFiles(normalizeForRender(spec, TEMPLATE), assets)).rejects.toThrow("An uploaded image is missing");
  });
});
