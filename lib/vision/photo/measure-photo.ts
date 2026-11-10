import type { Audience } from "@/lib/catalog/garment-types";
import { measurePhoto, type PhotoMeasure } from "@/lib/fit/measure";

import { VisionClient } from "../runtime/client";
import { maskAtSmooth } from "../models/segment";

// Measures the customer's body from their try-on photo in the browser (lib/fit/measure.ts), with the
// on-device body and outline models: the photo is already ours (a signed URL), and its measurements
// never leave the device except as the fit of a try-on the customer starts. Null when the models can't
// run on this device.

let shared: VisionClient | null = null;

function client(): VisionClient {
  shared ??= new VisionClient(["pose", "mask"]);
  return shared;
}

export async function measurePhotoOnDevice(url: string, audience: Audience): Promise<PhotoMeasure | null> {
  let bitmap: ImageBitmap | null = null;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const vision = client();
    await vision.ready;
    bitmap = await createImageBitmap(await response.blob(), { imageOrientation: "from-image" });
    const { width, height } = bitmap;
    const result = await vision.analyse(bitmap, { pose: true, mask: true });
    bitmap = null; // handed over to the worker
    const mask = result.mask;
    if (!result.pose || !mask) return null;
    return measurePhoto(audience, result.pose, (x, y) => maskAtSmooth(mask, x, y), width, height);
  } catch {
    bitmap?.close();
    shared?.dispose();
    shared = null;
    return null;
  }
}
