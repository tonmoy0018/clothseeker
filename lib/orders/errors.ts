export type OrderErrorCode =
  | "NOT_FOUND"
  | "CART_EMPTY"
  | "CART_CHANGED"
  | "INSUFFICIENT_STOCK"
  | "NOT_SUPPORTED"
  | "EXPIRED";

/** Expected, user-facing checkout/order failures. */
export class OrderError extends Error {
  override readonly name = "OrderError";

  constructor(
    readonly code: OrderErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type WebhookErrorCode = "UNKNOWN_PAYMENT" | "AMOUNT_MISMATCH";

/** A webhook we refuse to act on (the gateway gets a 4xx). Signature problems use WebhookVerificationError. */
export class PaymentWebhookError extends Error {
  override readonly name = "PaymentWebhookError";

  constructor(
    readonly code: WebhookErrorCode,
    message: string,
  ) {
    super(message);
  }
}
