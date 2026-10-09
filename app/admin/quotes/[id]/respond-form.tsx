"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import type { FormState } from "../../form-state";

import { respondToQuoteAction } from "./actions";

const initial: FormState = {};
const textarea =
  "rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function RespondForm({ quoteId }: { quoteId: string }) {
  const [priceState, sendPrice, pricing] = useActionState(respondToQuoteAction, initial);
  const [declineState, decline, declining] = useActionState(respondToQuoteAction, initial);
  const state = priceState.error || priceState.ok ? priceState : declineState;

  return (
    <div className="flex flex-col gap-4">
      <form action={sendPrice} className="flex flex-col gap-3 rounded-xl border p-4" aria-label="Send a price">
        <input type="hidden" name="quoteId" value={quoteId} />
        <input type="hidden" name="action" value="price" />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="priceTaka">Price (৳, before delivery)</Label>
          <Input id="priceTaka" name="priceTaka" inputMode="decimal" placeholder="e.g. 5200" className="w-40" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="priceNote">What the price includes</Label>
          <textarea id="priceNote" name="note" rows={3} maxLength={1000} className={textarea} placeholder="e.g. Includes the side slit and pleated skirt as in your photo" />
        </div>
        <Button type="submit" className="self-start" disabled={pricing}>
          Send price (valid 7 days)
        </Button>
      </form>
      <form action={decline} className="flex flex-col gap-3 rounded-xl border p-4" aria-label="Decline">
        <input type="hidden" name="quoteId" value={quoteId} />
        <input type="hidden" name="action" value="decline" />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="declineNote">Reason for declining</Label>
          <textarea id="declineNote" name="note" rows={2} maxLength={1000} className={textarea} />
        </div>
        <Button type="submit" variant="outline" className="self-start" disabled={declining}>
          Decline
        </Button>
      </form>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
          {state.ok}
        </p>
      )}
    </div>
  );
}
