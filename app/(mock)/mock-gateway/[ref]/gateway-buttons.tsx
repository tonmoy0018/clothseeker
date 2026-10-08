"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";

import { completeMockPaymentAction, type GatewayState } from "./actions";

function Submit({ outcome, children, variant }: { outcome: "succeeded" | "failed"; children: string; variant: "default" | "outline" }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" name="outcome" value={outcome} variant={variant} size="lg" disabled={pending} className="flex-1">
      {pending ? "Processing…" : children}
    </Button>
  );
}

export function GatewayButtons({ providerRef, returnTo, amount }: { providerRef: string; returnTo: string; amount: string }) {
  const [state, action] = useActionState(completeMockPaymentAction, {} satisfies GatewayState);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="ref" value={providerRef} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <div className="flex gap-3">
        <Submit outcome="succeeded" variant="default">{`Pay ${amount}`}</Submit>
        <Submit outcome="failed" variant="outline">
          Decline
        </Submit>
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
    </form>
  );
}
