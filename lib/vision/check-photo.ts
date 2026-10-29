import { AI_FAILURE_MESSAGES } from "@/lib/ai/errors";

import { VisionClient } from "./client";
import { isUsable, judgeTryOnPhoto, photoProblem } from "./photo-check";

// Checks a try-on photo in the browser before it is uploaded, with the same models and rules the worker
// uses. Returns the customer-facing reason when the photo won't work, or null when it will (or when the
// models can't run on this device: the worker still checks the photo after upload).

let shared: VisionClient | null = null;

function client(): VisionClient {
  shared ??= new VisionClient(["pose", "face"]);
  return shared;
}

export async function photoProblemOnDevice(photo: Blob): Promise<string | null> {
  let bitmap: ImageBitmap | null = null;
  try {
    const vision = client();
    await vision.ready;
    bitmap = await createImageBitmap(photo, { imageOrientation: "from-image" });
    const { width, height } = bitmap;
    const result = await vision.analyse(bitmap, { pose: true, face: true });
    bitmap = null; // handed over to the worker
    const check = judgeTryOnPhoto({ width, height, pose: result.pose, faces: result.faces, brightness: result.brightness });
    return isUsable(check) ? null : AI_FAILURE_MESSAGES[photoProblem(check)];
  } catch {
    bitmap?.close();
    shared?.dispose();
    shared = null;
    return null;
  }
}
