import { AiProviderError } from "./errors";

// Shared HTTP handling for provider adapters: maps network failures and status codes to
// retryable / non-retryable AiProviderErrors. Never puts response bodies (which may echo the
// prompt) or keys into error messages.

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export async function providerFetch(fetchImpl: FetchLike, provider: string, url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    if (init.signal?.aborted) {
      throw new AiProviderError(`${provider} request timed out`, true, "TIMEOUT");
    }
    throw new AiProviderError(`${provider} request failed (${error instanceof Error ? error.name : "network"})`, true);
  }
  if (!response.ok) {
    throw new AiProviderError(`${provider} returned HTTP ${response.status}`, RETRYABLE_STATUS.has(response.status));
  }
  return response;
}
