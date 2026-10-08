"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { resumePaymentAction, type CheckoutState } from "@/app/(shop)/checkout/actions";
import { Button } from "@/components/ui/button";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Opening payment…" : "Complete payment"}
    </Button>
  );
}

export function ResumePayment({ orderId }: { orderId: string }) {
  const [state, action] = useActionState(resumePaymentAction, {} satisfies CheckoutState);
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="orderId" value={orderId} />
      <Submit />
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
    </form>
  );
}
