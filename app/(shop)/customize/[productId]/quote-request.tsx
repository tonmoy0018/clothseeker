"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";

import { requestQuoteAction } from "../../account/quotes/actions";
import { textareaClass } from "@/components/ui/textarea";

/**
 * Photo-started designs may need special tailoring: the customer can ask the team for a price. The
 * customer's own dress (`ownDress`) is always priced this way, and needs no notes. Only saved designs can
 * be quoted (the quote freezes what was saved).
 */
export function QuoteRequest({
  designId,
  saved,
  onSignIn,
  ownDress = false,
  reference = "photo",
}: {
  designId: string | null;
  saved: boolean;
  onSignIn: () => void;
  ownDress?: boolean;
  /** What the design was started from: the customer's photo or drawing. */
  reference?: "photo" | "drawing";
}) {
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
    <section className="flex flex-col gap-2 rounded-2xl border bg-card p-4" data-testid="quote-request">
      <h2 className="font-medium">{ownDress ? "Get a price for your dress" : "Need special tailoring?"}</h2>
      <p className="text-sm text-muted-foreground">
        {ownDress
          ? "When you're happy with it (your size chosen, any changes saved), the ClothSeeker team will reply with a price within 24 hours; you then have 7 days to order."
          : `If the garment in your ${reference} needs changes our templates can't make, describe them and the ClothSeeker team will reply with a price within 24 hours.`}
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
            placeholder={ownDress ? "Anything the tailors should know? (optional)" : "e.g. Add a high slit on the left, and pleats like in my photo"}
            onChange={(e) => setNotes(e.target.value)}
            className={textareaClass}
          />
          <Button className="self-start" variant={ownDress ? "default" : "outline"} onClick={submit} disabled={pending || (!ownDress && notes.trim().length < 10)}>
            {pending ? "Sending…" : ownDress ? "Request a price" : "Request a tailoring quote"}
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
