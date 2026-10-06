// Expected, user-facing failures from shop services. Anything else is a bug and propagates.

export type ShopErrorCode =
  | "NOT_FOUND"
  | "UNAVAILABLE"
  | "INSUFFICIENT_STOCK"
  | "QUANTITY_LIMIT"
  | "CART_EMPTY"
  | "CART_CHANGED"
  | "PAYMENT_DECLINED"
  | "NOT_SUPPORTED";

export class ShopError extends Error {
  override readonly name = "ShopError";

  constructor(
    readonly code: ShopErrorCode,
    message: string,
  ) {
    super(message);
  }
}
