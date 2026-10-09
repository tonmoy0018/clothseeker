// Browser-only: shrinks a photo before upload so requests stay under Vercel's 4.5 MB body limit.
// The server still re-checks and re-encodes everything (lib/media/process-image.ts).

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_PHOTO_EDGE = 2000;
const SEND_AS_IS_BYTES = 3.5 * 1024 * 1024;

export async function downscalePhoto(file: File): Promise<Blob> {
  if (file.size > MAX_PHOTO_BYTES) {
    throw new Error("Photos can be up to 10 MB.");
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That file isn't a photo we can read. Use JPEG, PNG or WebP.");
  }
  const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= SEND_AS_IS_BYTES) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
  if (!blob) {
    throw new Error("That photo couldn't be prepared. Try another one.");
  }
  return blob;
}
