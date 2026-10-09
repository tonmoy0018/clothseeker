import { loadDesignContext, type DesignContext } from "@/lib/design/service";
import { BUCKETS } from "@/lib/storage/buckets";

import { AiError, AiJobRejected, AiProviderError } from "../errors";
import { createDesignRoundJob } from "../jobs";
import { DressMatchError, matchToSpec, parseDressMatch, startingSpec } from "../match";
import { dressMatchPayloadSchema, type DressMatchResult } from "../starts";
import type { DressCandidate } from "../types";

import { leaseWhere, LostLease, type ClaimedJob } from "./claim";
import type { AiWorkerDeps } from "./run";

// "Start from a dress photo / description", run by the worker:
//   candidates (live customizable dresses) → brand-logo check (photo) → planner.matchDress
//   → validated match → prefilled DRAFT design → (description) AI design round → job SUCCEEDED.

const MAX_CANDIDATES = 40;

async function loadCandidates(deps: AiWorkerDeps, aiOnly: boolean): Promise<{ candidates: DressCandidate[]; contexts: Map<string, DesignContext> }> {
  const products = await deps.db.product.findMany({
    where: { status: "ACTIVE", template: { isActive: true, ...(aiOnly ? { aiEnabled: true } : {}) } },
    orderBy: { name: "asc" },
    take: MAX_CANDIDATES,
    select: { id: true, name: true, description: true, category: { select: { name: true } } },
  });
  const candidates: DressCandidate[] = [];
  const contexts = new Map<string, DesignContext>();
  for (const product of products) {
    const context = await loadDesignContext(deps.db, deps.storage, product.id, { signImages: false });
    if (!context) continue;
    const config = context.template.config;
    contexts.set(product.id, context);
    candidates.push({
      productId: product.id,
      name: product.name,
      category: product.category.name,
      description: product.description.slice(0, 200),
      colors: config.allowedColors.map((c) => ({ name: c.name, hex: c.hex.toLowerCase() })),
      patterns: [...config.allowedPatterns],
      styleOptions: {
        neckline: config.styleOptions.neckline.map((o) => ({ id: o.id, label: o.label })),
        sleeveLength: config.styleOptions.sleeveLength.map((o) => ({ id: o.id, label: o.label })),
        dressLength: config.styleOptions.dressLength.map((o) => ({ id: o.id, label: o.label })),
      },
    });
  }
  return { candidates, contexts };
}

export async function runDressMatch(deps: AiWorkerDeps, job: ClaimedJob, signal: AbortSignal): Promise<void> {
  const { db, storage, providers } = deps;
  const parsed = dressMatchPayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    throw new AiJobRejected("INTERNAL");
  }
  const input = parsed.data;

  const { candidates, contexts } = await loadCandidates(deps, input.mode === "description");
  if (candidates.length === 0) {
    throw new AiJobRejected("NOT_AVAILABLE");
  }

  let image = null;
  if (input.mode === "photo") {
    const data = input.referenceKey ? await storage.get(BUCKETS.designAssets, input.referenceKey) : null;
    if (!data || !input.referenceKey) {
      throw new AiJobRejected("INTERNAL");
    }
    image = { data, mimeType: "image/webp" as const };
    const logo = await providers.planner.detectBrandLogos([image], signal);
    if (logo.detected) {
      await db.flaggedItem.create({
        data: {
          kind: "BRAND_LOGO",
          customerId: job.customerId,
          aiJobId: job.id,
          storageKey: input.referenceKey,
          reason: `Brand logo detected in a dress photo used to start a design${logo.label ? ` (${logo.label.slice(0, 60)})` : ""}.`,
        },
      });
      throw new AiJobRejected("BRAND_LOGO");
    }
  }

  const raw = await providers.planner.matchDress({ mode: input.mode, image, description: input.description, candidates, seed: input.seed }, signal);
  let match;
  try {
    match = parseDressMatch(raw, candidates);
  } catch (error) {
    if (error instanceof DressMatchError) {
      throw new AiProviderError("planner answer isn't a valid dress match", true, "INVALID_PLAN");
    }
    throw error;
  }
  const context = contexts.get(match.productId);
  const size = context?.availableSizes[0];
  if (!context || !size) {
    throw new AiJobRejected("NOT_AVAILABLE");
  }
  if (signal.aborted) {
    throw new AiProviderError("job aborted", true, "TIMEOUT");
  }

  const template = context.template;
  const base = startingSpec(
    { productId: template.productId, templateId: template.templateId, version: template.version, config: template.config },
    size,
    input.mode,
    input.referenceKey,
  );
  const spec = matchToSpec(base, match, {
    productId: template.productId,
    templateId: template.templateId,
    availableSizes: context.availableSizes,
    customerId: job.customerId,
    template: template.config,
  });

  const design = await db.design.create({
    data: {
      customerId: job.customerId,
      productId: spec.productId,
      templateId: spec.templateId,
      templateVersion: spec.templateVersion,
      spec,
      startedFrom: input.mode === "photo" ? "PHOTO" : "DESCRIPTION",
      referencePhotoKey: input.referenceKey,
      status: "DRAFT",
    },
    select: { id: true },
  });

  try {
    let roundJobId: string | null = null;
    if (input.mode === "description" && input.description) {
      try {
        const round = await createDesignRoundJob(db, storage, { id: job.customerId, role: "CUSTOMER" }, { designId: design.id, spec, instruction: input.description });
        roundJobId = round.jobId;
      } catch (error) {
        // E.g. today's rounds ran out meanwhile: the customer still gets the matched dress.
        if (!(error instanceof AiError)) throw error;
        deps.log?.("ai.start_round_skipped", { jobId: job.id, code: error.code });
      }
    }
    const result: DressMatchResult = { designId: design.id, productId: match.productId, alternatives: match.alternatives, roundJobId };
    const now = (deps.now ?? (() => new Date()))();
    const finished = await db.aIJob.updateMany({
      where: leaseWhere(job, deps.workerId),
      data: { status: "SUCCEEDED", result, finishedAt: now, lockedAt: null, lockedBy: null, error: null, errorCode: null },
    });
    if (finished.count !== 1) {
      throw new LostLease();
    }
    deps.log?.("ai.start_matched", { jobId: job.id, mode: input.mode, candidates: candidates.length, round: roundJobId !== null });
  } catch (error) {
    // The design (and any round queued for it) belongs to this attempt only.
    await db.aIJob.deleteMany({ where: { type: "DESIGN_ROUND", status: "QUEUED", customerId: job.customerId, payload: { path: ["designId"], equals: design.id } } });
    await db.design.delete({ where: { id: design.id } }).catch(() => undefined);
    throw error;
  }
}
