"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { DeliveryZone } from "@/lib/generated/prisma/enums";
import { formatBDT } from "@/lib/money";
import { DELIVERY_FEES_MINOR, DELIVERY_ZONE_LABEL, DELIVERY_ZONES } from "@/lib/orders/delivery";

import { placeOrderAction, type CheckoutState } from "./actions";

type Defaults = { name: string; phone: string; line1: string; line2: string; city: string; postalCode: string; zone: DeliveryZone };

function PlaceOrderButton({ total }: { total: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending} className="w-full">
      {pending ? "Placing your order…" : `Place order · ${total}`}
    </Button>
  );
}

/** Address + delivery form. The total shown here is a preview; the server recomputes it. */
export function CheckoutForm({ idempotencyKey, subtotalMinor, defaults }: { idempotencyKey: string; subtotalMinor: number; defaults: Defaults }) {
  const [state, action] = useActionState(placeOrderAction, {} satisfies CheckoutState);
  const [zone, setZone] = useState<DeliveryZone>(defaults.zone);
  const fee = DELIVERY_FEES_MINOR[zone];
  const err = (key: string) => state.fieldErrors?.[key];

  const text = (name: keyof Omit<Defaults, "zone">, label: string, props: { autoComplete: string; required?: boolean; maxLength: number; inputMode?: "tel" | "numeric" }) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} defaultValue={defaults[name]} aria-invalid={Boolean(err(`address.${name}`))} {...props} />
      {err(`address.${name}`) && <p className="text-xs text-destructive">{err(`address.${name}`)}</p>}
    </div>
  );

  return (
    <form action={action} className="flex flex-col gap-6">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 text-lg font-semibold">Delivery address</legend>
        {text("name", "Recipient name", { autoComplete: "name", required: true, maxLength: 80 })}
        {text("phone", "Mobile number", { autoComplete: "tel", required: true, maxLength: 20, inputMode: "tel" })}
        <div className="sm:col-span-2">{text("line1", "Address", { autoComplete: "address-line1", required: true, maxLength: 120 })}</div>
        <div className="sm:col-span-2">{text("line2", "Apartment, floor, landmark (optional)", { autoComplete: "address-line2", maxLength: 120 })}</div>
        {text("city", "City / district", { autoComplete: "address-level2", required: true, maxLength: 60 })}
        {text("postalCode", "Postal code (optional)", { autoComplete: "postal-code", maxLength: 4, inputMode: "numeric" })}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-lg font-semibold">Delivery</legend>
        {DELIVERY_ZONES.map((z) => (
          <label key={z} className="flex items-center justify-between rounded-lg border p-3 text-sm has-[:checked]:border-foreground">
            <span className="flex items-center gap-2">
              <input type="radio" name="zone" value={z} checked={zone === z} onChange={() => setZone(z)} className="size-4" />
              {DELIVERY_ZONE_LABEL[z]}
            </span>
            <span>{formatBDT(DELIVERY_FEES_MINOR[z])}</span>
          </label>
        ))}
      </fieldset>

      <div className="flex flex-col gap-1 rounded-xl border p-4 text-sm">
        <div className="flex justify-between">
          <span>Subtotal</span>
          <span>{formatBDT(subtotalMinor)}</span>
        </div>
        <div className="flex justify-between">
          <span>Delivery</span>
          <span>{formatBDT(fee)}</span>
        </div>
        <div className="mt-1 flex justify-between border-t pt-2 text-base font-semibold">
          <span>Total</span>
          <span data-testid="checkout-total">{formatBDT(subtotalMinor + fee)}</span>
        </div>
      </div>

      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <PlaceOrderButton total={formatBDT(subtotalMinor + fee)} />
      <p className="text-xs text-muted-foreground">
        You&apos;ll pay on our simulated payment page. Unpaid orders are released after 30 minutes. No real money is charged.
      </p>
    </form>
  );
}
