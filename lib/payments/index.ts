import "server-only";

import { getServerEnv } from "@/lib/env/server";

import { MockPaymentProvider } from "./mock";
import type { PaymentProvider } from "./types";

let provider: PaymentProvider | undefined;

/** The configured payment provider. Only "mock" exists today; add real ones here. */
export function getPaymentProvider(name?: string): PaymentProvider {
  const env = getServerEnv();
  if (name !== undefined && name !== env.PAYMENT_PROVIDER) {
    throw new Error("Unknown payment provider");
  }
  provider ??= new MockPaymentProvider(env.MOCK_PAYMENT_WEBHOOK_SECRET);
  return provider;
}
