// Payment gateway abstraction. Phase 1 ships a mock; Phase 4 extends the interface
// (callbacks, refunds) and a real sandbox provider can be added without touching checkout logic.

export type ChargeRequest = {
  /** Same key → same result. Providers must treat repeated keys as one charge. */
  idempotencyKey: string;
  amountMinor: number;
  currency: string;
  /** Our order number, for the provider's reference only. */
  reference: string;
};

export type ChargeResult = { status: "succeeded"; paymentRef: string } | { status: "declined"; reason: string };

export interface PaymentProvider {
  readonly name: string;
  charge(request: ChargeRequest): Promise<ChargeResult>;
}
