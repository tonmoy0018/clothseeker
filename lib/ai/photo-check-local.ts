import { judgeTryOnPhoto } from "@/lib/vision/photo-check";
import { NodeVision } from "@/lib/vision/node-vision";

import { AiProviderError } from "./errors";
import type { ProviderImage, TryOnPhotoCheck, TryOnPhotoChecker } from "./types";

// Try-on photo check with the on-device body and face models (Hugging Face, see lib/vision/assets.ts),
// run by the worker on our own machine: the photo isn't sent anywhere for this. The browser runs the
// same models and rules before uploading (judgeTryOnPhoto), so customers rarely get this far with a
// photo that fails.

export class LocalPhotoChecker implements TryOnPhotoChecker {
  readonly name = "local";
  private readonly vision = new NodeVision();

  async checkTryOnPhoto(image: ProviderImage, signal: AbortSignal): Promise<TryOnPhotoCheck> {
    if (signal.aborted) throw new AiProviderError("photo check aborted", true, "TIMEOUT");
    let analysis;
    try {
      analysis = await this.vision.analyse(image.data);
    } catch {
      throw new AiProviderError("the photo couldn't be checked", true);
    }
    return judgeTryOnPhoto(analysis);
  }
}
