import { AiProviderError } from "../errors";
import type { BrandLogoCheck, DressMatchRequest, PlannerProvider, PlanRequest, ProviderImage } from "../types";

// A planner with a stand-in (PLANNER_FALLBACK=local): the hosted planner answers when it can, and the
// model on our own machine takes over when it can't (busy, out of its free allowance, unreachable, a
// wrong key), so customers still get their designs, only slower. A request the hosted planner refused
// on purpose (a safety block) is not passed on, and neither is one that ran out of time.

/** Whether the stand-in should try: the first planner failed to answer, rather than refusing or timing out. */
export function shouldFallBack(error: unknown, signal: AbortSignal): boolean {
  if (!(error instanceof AiProviderError) || signal.aborted) return false;
  if (error.code === "PROVIDER") return true;
  // An unreadable or cut-off answer is worth a second opinion; a blocked request isn't.
  return error.code === "INVALID_PLAN" && error.retryable;
}

export class FallbackPlanner implements PlannerProvider {
  readonly name: string;

  constructor(
    private readonly first: PlannerProvider,
    private readonly standIn: PlannerProvider,
    private readonly onFallback?: (task: string) => void,
  ) {
    this.name = `${first.name}+${standIn.name}`;
  }

  close(): void {
    this.first.close?.();
    this.standIn.close?.();
  }

  detectBrandLogos(images: ProviderImage[], signal: AbortSignal): Promise<BrandLogoCheck> {
    return this.run("logo_check", (planner) => planner.detectBrandLogos(images, signal), signal);
  }

  planDesign(request: PlanRequest, signal: AbortSignal): Promise<unknown> {
    return this.run("plan", (planner) => planner.planDesign(request, signal), signal);
  }

  matchDress(request: DressMatchRequest, signal: AbortSignal): Promise<unknown> {
    return this.run("match", (planner) => planner.matchDress(request, signal), signal);
  }

  readGarment(image: ProviderImage, signal: AbortSignal): Promise<unknown> {
    return this.run("read", (planner) => planner.readGarment(image, signal), signal);
  }

  private async run<T>(task: string, call: (planner: PlannerProvider) => Promise<T>, signal: AbortSignal): Promise<T> {
    try {
      return await call(this.first);
    } catch (error) {
      if (!shouldFallBack(error, signal)) throw error;
      this.onFallback?.(task);
      return call(this.standIn);
    }
  }
}
