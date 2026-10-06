"use client";

import { Button } from "@/components/ui/button";

export default function ProductsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border p-8">
      <p className="font-medium">We couldn&apos;t load the dresses right now.</p>
      <p className="text-sm text-muted-foreground">Please try again in a moment.</p>
      <Button variant="outline" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
