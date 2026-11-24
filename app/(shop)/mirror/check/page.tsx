import type { Metadata } from "next";

import { VisionCheck } from "./vision-check";

export const metadata: Metadata = { title: "Live mirror check — ClothSeeker", robots: { index: false, follow: false } };

// A speed and accuracy check for the on-device body and face models (live try-on, step 1). Not linked
// from the shop. Nothing is uploaded: the camera feed and photos stay in the browser.

export default function MirrorCheckPage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Live mirror check</h1>
        <p className="text-sm text-muted-foreground">
          Tests the body and face detection that runs on this device. Your camera and photos stay in this browser: nothing is uploaded.
        </p>
      </div>
      <VisionCheck />
    </main>
  );
}
