"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

import type { FormState } from "../../form-state";

import { resolveDisputeAction } from "./actions";

const initial: FormState = {};

export function ResolveForm({ disputeId, amount }: { disputeId: string; amount: string }) {
  const [state, action, pending] = useActionState(resolveDisputeAction, initial);
  return (
    <form action={action} className="flex flex-col gap-3 rounded-xl border p-4" aria-label="Resolve dispute">
      <input type="hidden" name="disputeId" value={disputeId} />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="note">Note for the customer</Label>
        <textarea
          id="note"
          name="note"
          rows={3}
          maxLength={1000}
          className="rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="outcome" value="refund" disabled={pending}>
          Refund {amount}
        </Button>
        <Button type="submit" name="outcome" value="reject" variant="outline" disabled={pending}>
          No refund
        </Button>
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
    </form>
  );
}
