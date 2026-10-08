"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { MAX_UNITS_PER_LINE } from "@/lib/shop/limits";

import { removeItemAction, updateQuantityAction, type CartActionState } from "./actions";

const initial: CartActionState = {};

export function LineControls({ itemId, quantity }: { itemId: string; quantity: number }) {
  const [updateState, update, updating] = useActionState(updateQuantityAction, initial);
  const [removeState, remove, removing] = useActionState(removeItemAction, initial);
  const error = updateState.error ?? removeState.error;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <form action={update} className="flex items-center gap-1">
          <input type="hidden" name="itemId" value={itemId} />
          <label className="sr-only" htmlFor={`qty-${itemId}`}>
            Quantity
          </label>
          <select
            id={`qty-${itemId}`}
            name="quantity"
            defaultValue={quantity}
            className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
            onChange={(e) => e.currentTarget.form?.requestSubmit()}
            disabled={updating}
          >
            {Array.from({ length: Math.max(MAX_UNITS_PER_LINE, quantity) }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <noscript>
            <Button type="submit" variant="outline" size="sm">
              Update
            </Button>
          </noscript>
        </form>
        <form action={remove}>
          <input type="hidden" name="itemId" value={itemId} />
          <Button type="submit" variant="ghost" size="sm" disabled={removing}>
            Remove
          </Button>
        </form>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function RemoveOnly({ itemId }: { itemId: string }) {
  const [state, remove, removing] = useActionState(removeItemAction, initial);
  return (
    <form action={remove} className="flex flex-col items-end gap-1">
      <input type="hidden" name="itemId" value={itemId} />
      <Button type="submit" variant="ghost" size="sm" disabled={removing}>
        Remove
      </Button>
      {state.error && (
        <p role="alert" className="text-xs text-destructive">
          {state.error}
        </p>
      )}
    </form>
  );
}
