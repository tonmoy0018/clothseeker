// Browser-only: prepares any photo, however large, for upload. Requests must stay under Vercel's 4.5 MB
// body limit, so big photos are shrunk to at most MAX_PHOTO_EDGE and compressed until they fit. Small
// photos are sent as they are (the server enlarges them where needed). The server still re-checks and
// re-encodes everything (lib/media/process-image.ts).

const MAX_PHOTO_EDGE = 2000;
const SEND_AS_IS_BYTES = 3.5 * 1024 * 1024;
const QUALITIES = [0.88, 0.8, 0.7, 0.6];

async function decode(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    // Some browsers can't hold a very large photo at full size: let them decode it smaller.
    try {
      return await createImageBitmap(file, { resizeWidth: MAX_PHOTO_EDGE, resizeQuality: "high" });
    } catch {
      throw new Error("That file isn't a photo we can read. Use JPEG, PNG or WebP.");
    }
  }
}

export async function downscalePhoto(file: Blob): Promise<Blob> {
  const bitmap = await decode(file);
  const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= SEND_AS_IS_BYTES) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of QUALITIES) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) break;
    if (blob.size <= SEND_AS_IS_BYTES || quality === QUALITIES[QUALITIES.length - 1]) return blob;
  }
  throw new Error("That photo couldn't be prepared. Try another one.");
}
