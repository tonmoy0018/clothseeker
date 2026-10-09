"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import type { FormState } from "../form-state";

import { reviewFlagAction } from "./actions";

const initial: FormState = {};

export function ReviewForm({ flagId }: { flagId: string }) {
  const [state, action, pending] = useActionState(reviewFlagAction, initial);
  return (
    <form action={action} className="flex flex-col gap-2" aria-label="Review flag">
      <input type="hidden" name="flagId" value={flagId} />
      <Input name="note" placeholder="Note (optional)" aria-label="Note" maxLength={500} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" name="decision" value="confirm" disabled={pending}>
          Confirm logo (delete photo)
        </Button>
        <Button type="submit" size="sm" variant="outline" name="decision" value="dismiss" disabled={pending}>
          Dismiss — false alarm
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
