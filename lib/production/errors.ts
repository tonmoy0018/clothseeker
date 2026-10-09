export type ProductionErrorCode = "NOT_FOUND" | "INVALID_STATE" | "DEADLINE_PASSED" | "QC_INCOMPLETE" | "INVALID";

/** Expected failures of the team's order/production actions (shown in the admin UI). */
export class ProductionError extends Error {
  override readonly name = "ProductionError";

  constructor(
    readonly code: ProductionErrorCode,
    message: string,
  ) {
    super(message);
  }
}
