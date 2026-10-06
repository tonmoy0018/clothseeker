"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";

import { deleteDesignAction, type DeleteState } from "./actions";

export function DeleteDesignButton({ designId, label }: { designId: string; label: string }) {
  const [state, action, pending] = useActionState(deleteDesignAction, {} satisfies DeleteState);
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(`Delete your ${label} design? This can't be undone.`)) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="designId" value={designId} />
      <Button type="submit" size="xs" variant="ghost" disabled={pending} aria-label={`Delete ${label} design`}>
        {pending ? "Deleting…" : "Delete"}
      </Button>
      {state.error && <p className="text-xs text-destructive">{state.error}</p>}
    </form>
  );
}
