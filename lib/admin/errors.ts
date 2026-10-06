// Expected, user-facing failures from admin services.

export type AdminErrorCode = "NOT_FOUND" | "CONFLICT" | "INVALID" | "LIMIT" | "BLOCKED";

export class AdminError extends Error {
  override readonly name = "AdminError";

  constructor(
    readonly code: AdminErrorCode,
    message: string,
  ) {
    super(message);
  }
}
