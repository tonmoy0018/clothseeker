import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { ImageValidationError, MAX_UPLOAD_BYTES, processImage } from "@/lib/media/process-image";

function solid(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 90 } } });
}

async function expectCode(promise: Promise<unknown>, code: ImageValidationError["code"]) {
  await expect(promise).rejects.toSatisfy((e) => e instanceof ImageValidationError && e.code === code);
}

describe("processImage", () => {
  it.each(["jpeg", "png", "webp"] as const)("accepts %s and outputs WebP", async (format) => {
    const input = await solid(900, 1200).toFormat(format).toBuffer();
    const out = await processImage(input, "productPhoto");
    expect(out.contentType).toBe("image/webp");
    expect((await sharp(out.data).metadata()).format).toBe("webp");
    expect([out.width, out.height]).toEqual([900, 1200]);
  });

  it("strips EXIF metadata such as author and location", async () => {
    const input = await solid(800, 800)
      .jpeg()
      .withExif({ IFD0: { Artist: "Secret Person", Copyright: "GPS 23.8103N 90.4125E" } })
      .toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const out = await processImage(input, "productPhoto");
    expect((await sharp(out.data).metadata()).exif).toBeUndefined();
    expect(out.data.includes(Buffer.from("Secret Person"))).toBe(false);
  });

  it("downsizes large images to the output limit", async () => {
    const input = await solid(3000, 4000).jpeg().toBuffer();
    const out = await processImage(input, "productPhoto");
    expect(Math.max(out.width, out.height)).toBe(2000);
  });

  it("rejects SVG even though the decoder could read it", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900"><script>alert(1)</script><rect width="900" height="900"/></svg>');
    await expectCode(processImage(svg, "productPhoto"), "UNSUPPORTED");
  });

  it("rejects non-image bytes with an image extension", async () => {
    await expectCode(processImage(Buffer.from("hello, I am definitely a PNG"), "productPhoto"), "UNSUPPORTED");
  });

  it("rejects GIF and other formats", async () => {
    const gif = await solid(900, 900).gif().toBuffer();
    await expectCode(processImage(gif, "productPhoto"), "UNSUPPORTED");
  });

  it("enforces minimum dimensions per purpose", async () => {
    const small = await solid(500, 700).png().toBuffer();
    await expectCode(processImage(small, "productPhoto"), "TOO_SMALL");
    await expect(processImage(small, "styleReference")).resolves.toBeDefined();
    const garment = await solid(700, 900).png().toBuffer();
    await expectCode(processImage(garment, "garment"), "TOO_SMALL");
  });

  it("rejects empty and oversize uploads before decoding", async () => {
    await expectCode(processImage(new Uint8Array(0), "productPhoto"), "EMPTY");
    await expectCode(processImage(new Uint8Array(MAX_UPLOAD_BYTES + 1), "productPhoto"), "TOO_LARGE");
  });
});
