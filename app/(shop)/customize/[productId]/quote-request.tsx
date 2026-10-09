"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";

import { requestQuoteAction } from "../../account/quotes/actions";

/**
 * Photo-started designs may need special tailoring: the customer can ask the team for a price.
 * Only saved designs can be quoted (the quote freezes what was saved).
 */
export function QuoteRequest({ designId, saved, onSignIn }: { designId: string | null; saved: boolean; onSignIn: () => void }) {
  const router = useRouter();
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    if (!designId) return;
    setError(null);
    startTransition(async () => {
      const result = await requestQuoteAction(designId, notes);
      if (result.status === "signin") {
        onSignIn();
        return;
      }
      if (result.status === "error") {
        setError(result.message);
        return;
      }
      router.push(`/account/quotes/${result.quoteId}`);
    });
  }

  return (
    <section className="flex flex-col gap-2 rounded-xl border p-4" data-testid="quote-request">
      <h2 className="font-medium">Need special tailoring?</h2>
      <p className="text-sm text-muted-foreground">
        If the dress in your photo needs changes our templates can&apos;t make, describe them and the ClothSeeker team will reply with a price within 24 hours.
      </p>
      {!designId || !saved ? (
        <p className="text-sm">Save your design first, then request a quote.</p>
      ) : (
        <>
          <textarea
            aria-label="Notes for the tailors"
            value={notes}
            maxLength={1000}
            rows={3}
            placeholder="e.g. Add a high slit on the left, and pleats like in my photo"
            onChange={(e) => setNotes(e.target.value)}
            className="rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <Button className="self-start" variant="outline" onClick={submit} disabled={pending || notes.trim().length < 10}>
            {pending ? "Sending…" : "Request a tailoring quote"}
          </Button>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
