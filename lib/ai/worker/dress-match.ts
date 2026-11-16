import { styleOptionsFor, templateStyleGroups } from "@/types/template";
import { loadDesignContext, type DesignContext } from "@/lib/design/service";
import { ImageValidationError, processImage } from "@/lib/media/process-image";
import { buildOwnDress, OwnDressError, removeOwnDress } from "@/lib/own-dress/build";
import { parseGarmentReading } from "@/lib/own-dress/read";
import { customerSketchRenderPrefix } from "@/lib/design/validate";
import { BUCKETS } from "@/lib/storage/buckets";
import { buildObjectKey } from "@/lib/storage/object-key";

import { AiError, AiJobRejected, AiProviderError } from "../errors";
import { createDesignRoundJob } from "../jobs";
import { DressMatchError, matchToSpec, parseDressMatch, startingSpec } from "../match";
import { dressMatchPayloadSchema, SKETCH_RENDERS, type DressMatchPayload, type DressMatchResult, type SketchRendersResult } from "../starts";
import type { DressCandidate, ProviderImage } from "../types";

import { leaseWhere, LostLease, type ClaimedJob } from "./claim";
import type { AiWorkerDeps } from "./run";

// "Start from a dress photo / description", run by the worker:
//   candidates (live customizable dresses) → brand-logo check (photo) → planner.matchDress
//   → validated match → prefilled DRAFT design → (description) AI design round → job SUCCEEDED.
// Or, for "your own dress": brand-logo check → (a drawing) the rendering the customer picked
//   → the photo made into a private template (lib/own-dress) → a draft (customise) or saved (exact)
//   design on it → job SUCCEEDED.
// Or, for a drawing's renderings ("sketch"): brand-logo check → SKETCH_RENDERS realistic photos of it,
//   stored for the customer to pick from → job SUCCEEDED.

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
      garmentType: config.garmentType,
      styleOptions: Object.fromEntries(templateStyleGroups(config).map((g) => [g, styleOptionsFor(config, g).map((o) => ({ id: o.id, label: o.label }))])),
    });
  }
  return { candidates, contexts };
}

/** The customer's dress photo, refused (and flagged for the team) when it shows a clothing brand's logo. */
async function checkedPhoto(deps: AiWorkerDeps, job: ClaimedJob, referenceKey: string | null, signal: AbortSignal): Promise<ProviderImage> {
  const data = referenceKey ? await deps.storage.get(BUCKETS.designAssets, referenceKey) : null;
  if (!data || !referenceKey) {
    throw new AiJobRejected("INTERNAL");
  }
  const image = { data, mimeType: "image/webp" as const };
  const logo = await deps.providers.planner.detectBrandLogos([image], signal);
  if (logo.detected) {
    await deps.db.flaggedItem.create({
      data: {
        kind: "BRAND_LOGO",
        customerId: job.customerId,
        aiJobId: job.id,
        storageKey: referenceKey,
        reason: `Brand logo detected in a dress photo used to start a design${logo.label ? ` (${logo.label.slice(0, 60)})` : ""}.`,
      },
    });
    throw new AiJobRejected("BRAND_LOGO");
  }
  return image;
}

/** "Your own dress": their photo becomes a private template of its own (lib/own-dress), to customise or order exactly. */
async function runOwnDress(deps: AiWorkerDeps, job: ClaimedJob, input: DressMatchPayload, signal: AbortSignal): Promise<void> {
  const { db, storage } = deps;
  if (!input.own || !input.referenceKey) {
    throw new AiJobRejected("INTERNAL");
  }
  const photo = await checkedPhoto(deps, job, input.referenceKey, signal);
  let source = photo;
  let shot = false;
  const sketch = input.own.sketch === true;
  const garmentShot = deps.providers.garmentShot;
  if (sketch && input.own.renderKey) {
    // The rendering of the drawing the customer picked (a "sketch" job made it, under their own folder).
    if (!input.own.renderKey.startsWith(customerSketchRenderPrefix(job.customerId))) throw new AiJobRejected("INTERNAL");
    const picked = await deps.storage.get(BUCKETS.designAssets, input.own.renderKey);
    if (!picked) throw new AiJobRejected("SKETCH_NOT_RENDERED");
    source = { data: picked, mimeType: "image/webp" };
  } else if (sketch) {
    // A drawing can't be cut out as it is: an image model draws the garment as a real one first. Without
    // a picture there's nothing to make (a busy service is retried: its error is thrown).
    const raw = await deps.providers.sketch?.renderSketch(photo, input.own.note ?? null, signal);
    if (!raw) throw new AiJobRejected("SKETCH_NOT_RENDERED");
    try {
      const image = await processImage(raw, "aiInput");
      source = { data: image.data, mimeType: "image/webp" };
    } catch (error) {
      if (error instanceof ImageValidationError) throw new AiJobRejected("SKETCH_NOT_RENDERED");
      throw error;
    }
  } else if (garmentShot) {
    // A clean product shot of the same garment, when an image model is configured and willing (it isn't on
    // a free key without an image allowance): the garment is then read and cut out of that instead.
    try {
      const raw = await garmentShot.productShot(photo, signal);
      if (raw) {
        const image = await processImage(raw, "aiInput");
        source = { data: image.data, mimeType: "image/webp" };
        shot = true;
      }
    } catch (error) {
      if (signal.aborted) throw new AiProviderError("job aborted", true, "TIMEOUT");
      deps.log?.("ai.own_dress_no_shot", { jobId: job.id, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  // What the AI reads in the photo (type, where the garment is, its parts, style, colours, details). A
  // help, not a need: if it can't answer, the garment is cut out and named as without it.
  let reading = null;
  try {
    reading = parseGarmentReading(await deps.providers.planner.readGarment(source, signal));
  } catch (error) {
    if (signal.aborted) throw new AiProviderError("job aborted", true, "TIMEOUT");
    deps.log?.("ai.own_dress_unread", { jobId: job.id, error: error instanceof Error ? error.name : "unknown" });
  }
  if (signal.aborted) {
    throw new AiProviderError("job aborted", true, "TIMEOUT");
  }
  let built;
  try {
    built = await buildOwnDress(db, storage, {
      customerId: job.customerId,
      referenceKey: input.referenceKey,
      photo: source.data,
      garmentType: input.own.garmentType,
      exact: input.own.exact,
      reading,
      shot,
      sketch,
    });
  } catch (error) {
    if (error instanceof OwnDressError) throw new AiJobRejected("GARMENT_NOT_FOUND");
    throw error;
  }
  try {
    const result: DressMatchResult = { designId: built.designId, productId: built.productId, alternatives: [], roundJobId: null };
    const now = (deps.now ?? (() => new Date()))();
    const finished = await db.aIJob.updateMany({
      where: leaseWhere(job, deps.workerId),
      data: { status: "SUCCEEDED", result, finishedAt: now, lockedAt: null, lockedBy: null, error: null, errorCode: null },
    });
    if (finished.count !== 1) {
      throw new LostLease();
    }
    deps.log?.("ai.start_own_dress", { jobId: job.id, exact: input.own.exact, read: reading !== null, boxed: reading?.box != null, parts: reading?.parts.length ?? 0, shot, sketch });
  } catch (error) {
    // The dress belongs to this attempt only.
    await removeOwnDress(db, storage, built.productId).catch(() => undefined);
    throw error;
  }
}

/**
 * "From a drawing", first step: SKETCH_RENDERS realistic photos of the garment drawn, stored under the
 * customer's sketch-renders/ for them to pick the closest (which then becomes their own dress). Renderings
 * that fail are skipped; none at all is SKETCH_NOT_RENDERED. A busy service is retried (its error is thrown).
 */
async function runSketchRenders(deps: AiWorkerDeps, job: ClaimedJob, input: DressMatchPayload, signal: AbortSignal): Promise<void> {
  const { db, storage } = deps;
  if (!input.renders || !input.referenceKey) {
    throw new AiJobRejected("INTERNAL");
  }
  const drawing = await checkedPhoto(deps, job, input.referenceKey, signal);
  const renderer = deps.providers.sketch;
  if (!renderer) throw new AiJobRejected("SKETCH_NOT_RENDERED");
  const stored: string[] = [];
  try {
    for (let i = 0; i < SKETCH_RENDERS; i += 1) {
      // Later rounds ("show me more") get other variants of the fake; real models differ every time.
      const raw = await renderer.renderSketch(drawing, input.renders.note, signal, input.renders.round * SKETCH_RENDERS + i);
      if (signal.aborted) throw new AiProviderError("job aborted", true, "TIMEOUT");
      if (!raw) continue;
      let image;
      try {
        image = await processImage(raw, "aiInput");
      } catch (error) {
        if (error instanceof ImageValidationError) continue;
        throw error;
      }
      const key = buildObjectKey(BUCKETS.designAssets, { ownerId: job.customerId, category: "sketch-renders", extension: image.extension });
      await storage.put(BUCKETS.designAssets, key, image.data, image.contentType);
      stored.push(key);
    }
    if (stored.length === 0) throw new AiJobRejected("SKETCH_NOT_RENDERED");
    const result: SketchRendersResult = { renders: stored };
    const now = (deps.now ?? (() => new Date()))();
    const finished = await db.aIJob.updateMany({
      where: leaseWhere(job, deps.workerId),
      data: { status: "SUCCEEDED", result, finishedAt: now, lockedAt: null, lockedBy: null, error: null, errorCode: null },
    });
    if (finished.count !== 1) {
      throw new LostLease();
    }
    deps.log?.("ai.sketch_rendered", { jobId: job.id, renders: stored.length, round: input.renders.round });
  } catch (error) {
    // The renderings belong to this attempt only.
    await storage.remove(BUCKETS.designAssets, stored).catch(() => undefined);
    throw error;
  }
}

export async function runDressMatch(deps: AiWorkerDeps, job: ClaimedJob, signal: AbortSignal): Promise<void> {
  const { db, storage, providers } = deps;
  const parsed = dressMatchPayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    throw new AiJobRejected("INTERNAL");
  }
  const input = parsed.data;
  if (input.mode === "own") {
    return runOwnDress(deps, job, input, signal);
  }
  if (input.mode === "sketch") {
    return runSketchRenders(deps, job, input, signal);
  }
  const mode = input.mode;

  const { candidates, contexts } = await loadCandidates(deps, mode === "description");
  if (candidates.length === 0) {
    throw new AiJobRejected("NOT_AVAILABLE");
  }

  const image = mode === "photo" ? await checkedPhoto(deps, job, input.referenceKey, signal) : null;

  const raw = await providers.planner.matchDress({ mode, image, description: input.description, candidates, seed: input.seed }, signal);
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
    mode,
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
      referenceIsDrawing: input.mode === "photo" && input.drawing === true,
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
