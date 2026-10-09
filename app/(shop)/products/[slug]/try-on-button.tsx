"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

import { TryOnPanel } from "../../try-on-panel";

/** "Try on" for a ready-made dress: opens the try-on panel in place. */
export function TryOnButton({ productId, slug, signedIn }: { productId: string; slug: string; signedIn: boolean }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return (
    <div className="flex w-full flex-col gap-3">
      <Button variant="outline" className="self-start" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? "Hide try-on" : "Try on"}
      </Button>
      {open && (
        <TryOnPanel
          source={{ kind: "product", productId }}
          signedIn={signedIn}
          onSignIn={() => router.push(`/login?next=${encodeURIComponent(`/products/${slug}`)}`)}
        />
      )}
    </div>
  );
}
