"use client";

import { Box, Camera, Shirt } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Garment3dView } from "@/app/(shop)/_model-3d/garment-3d-view";
import { Button } from "@/components/ui/button";

import { LiveMirror } from "./live-mirror";
import { TryOnPanel, type TryOnGarmentFacts } from "./try-on-panel";

/** "Try on" (the realistic AI photo), "Live mirror" (the camera, on this device) and "3D view" for a ready-made garment. */
export function TryOnButton({
  productId,
  slug,
  signedIn,
  noun,
  garment,
  mirrorImageUrl,
}: {
  productId: string;
  slug: string;
  signedIn: boolean;
  noun: string;
  garment: TryOnGarmentFacts;
  mirrorImageUrl: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [mirror, setMirror] = useState(false);
  const [view3d, setView3d] = useState(false);
  const [mirrorPhoto, setMirrorPhoto] = useState<Blob | null>(null);
  const router = useRouter();
  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <Shirt aria-hidden />
          {open ? "Hide try-on" : "Try on"}
        </Button>
        {mirrorImageUrl && (
          <Button variant="outline" onClick={() => setMirror(true)}>
            <Camera aria-hidden />
            Live mirror
          </Button>
        )}
        {mirrorImageUrl && (
          <Button variant="outline" data-testid="open-3d-view" onClick={() => setView3d(true)}>
            <Box aria-hidden />
            3D view
          </Button>
        )}
      </div>
      {open && (
        <TryOnPanel
          source={{ kind: "product", productId }}
          signedIn={signedIn}
          noun={noun}
          garment={garment}
          offeredPhoto={mirrorPhoto}
          onSignIn={() => router.push(`/login?next=${encodeURIComponent(`/products/${slug}`)}`)}
        />
      )}
      {view3d && (
        <Garment3dView
          source={{ kind: "product", productId }}
          signedIn={signedIn}
          noun={noun}
          onSignIn={() => router.push(`/login?next=${encodeURIComponent(`/products/${slug}`)}`)}
          onClose={() => setView3d(false)}
        />
      )}
      {mirror && mirrorImageUrl && (
        <LiveMirror
          noun={noun}
          loadGarment={async (readParts) => (await import("@/lib/vision/mirror/garment-source")).garmentFromPhoto(mirrorImageUrl, readParts)}
          onClose={() => setMirror(false)}
          realistic={{ source: { kind: "product", productId }, signedIn, onSignIn: () => router.push(`/login?next=${encodeURIComponent(`/products/${slug}`)}`) }}
          onUsePhoto={(photo) => {
            setMirrorPhoto(photo);
            setOpen(true);
          }}
        />
      )}
    </div>
  );
}
