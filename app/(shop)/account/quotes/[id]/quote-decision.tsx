"use client";

import Link from "next/link";
import { useActionState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import type { QuoteStatus } from "@/lib/generated/prisma/enums";

import { acceptQuoteAction, withdrawQuoteAction, type QuoteFormState } from "../actions";

const initial: QuoteFormState = { error: null };

export function QuoteDecision({ quoteId, status, inCart }: { quoteId: string; status: QuoteStatus; inCart: boolean }) {
  const [acceptState, accept, accepting] = useActionState(acceptQuoteAction, initial);
  const [withdrawState, withdraw, withdrawing] = useActionState(withdrawQuoteAction, initial);
  const error = acceptState.error ?? withdrawState.error;

  if (status !== "REQUESTED" && status !== "QUOTED") {
    return null;
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {status === "QUOTED" &&
          (inCart ? (
            <Link href="/cart" className={buttonVariants()}>
              In your cart — check out
            </Link>
          ) : (
            <form action={accept}>
              <input type="hidden" name="quoteId" value={quoteId} />
              <Button type="submit" disabled={accepting}>
                Accept and add to cart
              </Button>
            </form>
          ))}
        <form action={withdraw}>
          <input type="hidden" name="quoteId" value={quoteId} />
          <Button type="submit" variant="outline" disabled={withdrawing}>
            {status === "QUOTED" ? "No thanks" : "Withdraw request"}
          </Button>
        </form>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive" data-testid="quote-error">
          {error}
        </p>
      )}
    </div>
  );
}
