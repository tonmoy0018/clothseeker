// Errors shared by AI job creation (app) and AI job processing (worker).

/** Exact wording required by the product spec. */
export const BRAND_LOGO_MESSAGE = "Clothing brand logos can't be used. Try your own logo or another image.";

/** Customer-safe failure reasons stored on ai_jobs.error_code. */
export const AI_FAILURE_CODES = ["BRAND_LOGO", "TIMEOUT", "PROVIDER", "INVALID_PLAN", "NOT_AVAILABLE", "INTERNAL"] as const;
export type AiFailureCode = (typeof AI_FAILURE_CODES)[number];

export const AI_FAILURE_MESSAGES: Record<AiFailureCode, string> = {
  BRAND_LOGO: BRAND_LOGO_MESSAGE,
  TIMEOUT: "The design helper took too long. Please try again.",
  PROVIDER: "The design helper couldn't finish this time. Please try again in a minute.",
  INVALID_PLAN: "The design helper couldn't make designs that fit this dress. Try describing it differently.",
  NOT_AVAILABLE: "This dress can't be customized right now.",
  INTERNAL: "Something went wrong while making your designs. Please try again.",
};

export function isAiFailureCode(code: unknown): code is AiFailureCode {
  return AI_FAILURE_CODES.some((c) => c === code);
}

export function failureMessage(code: string | null): string {
  return isAiFailureCode(code) ? AI_FAILURE_MESSAGES[code] : AI_FAILURE_MESSAGES.INTERNAL;
}

/**
 * Thrown by provider adapters. `retryable` separates transient failures (rate limits, timeouts, 5xx,
 * network) from requests that will fail the same way again (bad request, bad key).
 */
export class AiProviderError extends Error {
  override readonly name = "AiProviderError";

  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code: "TIMEOUT" | "PROVIDER" | "INVALID_PLAN" = "PROVIDER",
  ) {
    super(message);
  }
}

/** A job that must not be retried (e.g. a brand logo was found). */
export class AiJobRejected extends Error {
  override readonly name = "AiJobRejected";

  constructor(readonly code: AiFailureCode) {
    super(code);
  }
}

export type AiErrorCode = "INVALID" | "NOT_FOUND" | "NOT_AVAILABLE" | "QUOTA" | "BRAND_LOGO" | "UPLOAD_INVALID";

/** Thrown to customers by job creation, polling and picking. Messages are safe to show. */
export class AiError extends Error {
  override readonly name = "AiError";

  constructor(
    readonly code: AiErrorCode,
    message: string,
  ) {
    super(message);
  }
}
