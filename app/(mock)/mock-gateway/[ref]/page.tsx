import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireUser } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { formatBDT } from "@/lib/money";
import { getPaymentForCustomer } from "@/lib/orders/queries";

import { GatewayButtons } from "./gateway-buttons";

export const metadata: Metadata = { title: "MockPay — simulated payment" };

export default async function MockGatewayPage({ params, searchParams }: PageProps<"/mock-gateway/[ref]">) {
  const { ref } = await params;
  const user = await requireUser(`/mock-gateway/${ref}`);
  const payment = /^mockpay_[0-9a-f]{24}$/.test(ref) ? await getPaymentForCustomer(getPrisma(), user, ref) : null;
  if (!payment) {
    notFound();
  }
  const returnTo = `/account/orders/${payment.order.id}`;
  const back = (await searchParams).return;
  const cancelHref = typeof back === "string" && back === returnTo ? back : returnTo;
  const payable = payment.status === "PENDING" && payment.order.status === "PENDING_PAYMENT" && (!payment.order.expiresAt || payment.order.expiresAt > new Date());

  return (
    <div className="flex w-full max-w-md flex-col gap-6 rounded-2xl border bg-white p-8 shadow-sm dark:bg-slate-900" data-testid="mock-gateway">
      <div className="flex flex-col gap-1">
        <span className="w-fit rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">Simulated payment gateway — no real money moves</span>
        <h1 className="text-xl font-semibold">MockPay</h1>
        <p className="text-sm text-muted-foreground">Paying ClothSeeker for order {payment.order.number}</p>
      </div>
      <div className="flex items-baseline justify-between border-y py-4">
        <span className="text-sm text-muted-foreground">Amount</span>
        <span className="text-2xl font-semibold" data-testid="gateway-amount">
          {formatBDT(payment.amountMinor)}
        </span>
      </div>
      {payable ? (
        <>
          <GatewayButtons providerRef={payment.providerRef} returnTo={returnTo} amount={formatBDT(payment.amountMinor)} />
          <Link href={cancelHref} className="text-center text-sm text-muted-foreground underline underline-offset-4">
            Cancel and return to ClothSeeker
          </Link>
        </>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <p>This payment can&apos;t be completed any more (it was already processed, or the order expired).</p>
          <Link href={returnTo} className="underline underline-offset-4">
            Back to your order
          </Link>
        </div>
      )}
    </div>
  );
}
