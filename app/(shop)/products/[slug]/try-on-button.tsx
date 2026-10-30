"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

import { LiveMirror } from "../../live-mirror";
import { TryOnPanel } from "../../try-on-panel";

/** "Try on" (the realistic AI photo) and "Live mirror" (the camera, on this device) for a ready-made garment. */
export function TryOnButton({ productId, slug, signedIn, noun, mirrorImageUrl }: { productId: string; slug: string; signedIn: boolean; noun: string; mirrorImageUrl: string | null }) {
  const [open, setOpen] = useState(false);
  const [mirror, setMirror] = useState(false);
  const [mirrorPhoto, setMirrorPhoto] = useState<Blob | null>(null);
  const router = useRouter();
  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide try-on" : "Try on"}
        </Button>
        {mirrorImageUrl && (
          <Button variant="outline" onClick={() => setMirror(true)}>
            Live mirror
          </Button>
        )}
      </div>
      {open && (
        <TryOnPanel
          source={{ kind: "product", productId }}
          signedIn={signedIn}
          noun={noun}
          offeredPhoto={mirrorPhoto}
          onSignIn={() => router.push(`/login?next=${encodeURIComponent(`/products/${slug}`)}`)}
        />
      )}
      {mirror && mirrorImageUrl && (
        <LiveMirror
          noun={noun}
          loadGarment={async () => (await import("@/lib/vision/garment-source")).garmentFromPhoto(mirrorImageUrl)}
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
