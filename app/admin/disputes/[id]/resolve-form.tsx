"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

import type { FormState } from "../../form-state";

import { resolveDisputeAction } from "./actions";
import { textareaClass } from "@/components/ui/textarea";

const initial: FormState = {};

export function ResolveForm({ disputeId, amount }: { disputeId: string; amount: string }) {
  const [state, action, pending] = useActionState(resolveDisputeAction, initial);
  return (
    <form action={action} className="flex flex-col gap-3 rounded-2xl border bg-card p-4" aria-label="Resolve dispute">
      <input type="hidden" name="disputeId" value={disputeId} />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="note">Note for the customer</Label>
        <textarea
          id="note"
          name="note"
          rows={3}
          maxLength={1000}
          className={textareaClass}
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
