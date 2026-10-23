"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

import { TryOnPanel } from "../../try-on-panel";

/** "Try on" for a ready-made garment: opens the try-on panel in place. */
export function TryOnButton({ productId, slug, signedIn, noun }: { productId: string; slug: string; signedIn: boolean; noun: string }) {
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
          noun={noun}
          onSignIn={() => router.push(`/login?next=${encodeURIComponent(`/products/${slug}`)}`)}
        />
      )}
    </div>
  );
}
