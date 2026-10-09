import { randomUUID } from "node:crypto";

import sharp from "sharp";
import { ZodError } from "zod";

import { normalizeForRender } from "@/lib/design/normalize";
import { checkDesign, DesignError, type CheckedDesign } from "@/lib/design/service";
import { ImageValidationError, processImage } from "@/lib/media/process-image";
import { renderPreview, storageAssets } from "@/lib/renderer/render";
import { BUCKETS } from "@/lib/storage/buckets";
import { buildObjectKey } from "@/lib/storage/object-key";
import { parseDesignSpec, type DesignSpec } from "@/types/design-spec";

import { findBrandTerm } from "../brands";
import { AiJobRejected, AiProviderError } from "../errors";
import { parsePlan, planConstraints, summarizeSpec, variationToSpec, type PlannedOption } from "../plan";
import { designRoundPayloadSchema, storedOptionsSchema, type StoredOption } from "../rounds";
import type { PlanSummary, ProviderImage } from "../types";

import { leaseWhere, LostLease, type ClaimedJob } from "./claim";
import type { AiWorkerDeps } from "./run";

// One AI design round, run by the worker:
//   brand-logo check → plan (4 variations) → fit each to the template → motif image → preview
//   → one transaction: AIRound + job SUCCEEDED.
// Every stored file is removed again if the round doesn't complete.

/** Preview width for option cards (smaller than the editor's 1200 px preview). */
export const OPTION_PREVIEW_WIDTH = 600;

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AiProviderError("job aborted", true, "TIMEOUT");
  }
}

/** Seed for an option's motif: stable for the same request, different per option. */
function motifSeed(seed: string, index: number): number {
  return Number.parseInt(seed.slice(index * 6, index * 6 + 8), 16) % 2_147_483_647;
}

/**
 * Provider images often come on a white background; make near-white transparent so only the motif
 * is printed, then crop the empty margins. Also decodes the untrusted bytes, so anything that isn't
 * an image fails here.
 */
export async function knockOutWhite(input: Buffer): Promise<Buffer> {
  let raw;
  try {
    raw = await sharp(input, { limitInputPixels: 4096 * 4096, failOn: "error" })
      .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new AiProviderError("image provider returned an unreadable image", true);
  }
  const { data, info } = raw;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const lightest = Math.min(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
    if (lightest >= 245) {
      data[i + 3] = 0;
    } else if (lightest > 225) {
      // Soft edge between the motif and the background.
      data[i + 3] = Math.min(data[i + 3] ?? 255, Math.round(((245 - lightest) / 20) * 255));
    }
  }
  const cleaned = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  // Image models leave wide empty margins; crop to the motif so it fills its box on the dress.
  try {
    return await sharp(cleaned).trim({ threshold: 1 }).png().toBuffer();
  } catch {
    return cleaned; // nothing left to trim against (e.g. a fully transparent image)
  }
}

async function loadAttachments(deps: AiWorkerDeps, keys: readonly string[]): Promise<ProviderImage[]> {
  const images: ProviderImage[] = [];
  for (const key of keys) {
    const data = await deps.storage.get(BUCKETS.designAssets, key);
    if (!data) {
      throw new AiJobRejected("INTERNAL");
    }
    images.push({ data, mimeType: "image/webp" });
  }
  return images;
}

async function referenceSummary(deps: AiWorkerDeps, job: ClaimedJob, reference: { roundId: string; optionIndex: number } | null): Promise<PlanSummary | null> {
  if (!reference) {
    return null;
  }
  const round = await deps.db.aIRound.findFirst({ where: { id: reference.roundId, customerId: job.customerId }, select: { options: true } });
  const options = storedOptionsSchema.safeParse(round?.options);
  const option = options.success ? options.data[reference.optionIndex] : undefined;
  if (!option) {
    return null;
  }
  try {
    return summarizeSpec(parseDesignSpec(option.spec));
  } catch {
    return null;
  }
}

export async function runDesignRound(deps: AiWorkerDeps, job: ClaimedJob, signal: AbortSignal): Promise<void> {
  const { db, storage, providers } = deps;
  const payload = designRoundPayloadSchema.safeParse(job.payload);
  if (!payload.success) {
    throw new AiJobRejected("INTERNAL");
  }
  const input = payload.data;

  // The template may have changed since the request was queued: revalidate against the live one.
  let checked: CheckedDesign;
  try {
    checked = await checkDesign(db, storage, job.customerId, input.baseSpec);
  } catch (error) {
    if (error instanceof DesignError) {
      throw new AiJobRejected("NOT_AVAILABLE");
    }
    throw error;
  }
  const { spec: base, context } = checked;
  const design = await db.design.findFirst({ where: { id: input.designId, customerId: job.customerId }, select: { id: true } });
  if (!context.template.aiEnabled || !design) {
    throw new AiJobRejected("NOT_AVAILABLE");
  }

  // 1. Brand logos: in the words (again, in case the brand list grew) and in the photos.
  const images = await loadAttachments(deps, input.attachmentKeys);
  if (findBrandTerm(input.instruction)) {
    throw new AiJobRejected("BRAND_LOGO");
  }
  if (images.length > 0) {
    const logo = await providers.planner.detectBrandLogos(images, signal);
    if (logo.detected) {
      await db.flaggedItem.create({
        data: {
          kind: "BRAND_LOGO",
          customerId: job.customerId,
          aiJobId: job.id,
          storageKey: input.attachmentKeys[0] ?? null,
          reason: `Brand logo detected in a photo attached to an AI design request${logo.label ? ` (${logo.label.slice(0, 60)})` : ""}.`,
        },
      });
      throw new AiJobRejected("BRAND_LOGO");
    }
  }
  throwIfAborted(signal);

  // 2. Plan. The answer is untrusted until parsePlan + variationToSpec have checked it.
  const constraints = planConstraints(context.template.config, context.template.productName);
  const raw = await providers.planner.planDesign(
    {
      instruction: input.instruction,
      images,
      constraints,
      current: summarizeSpec(base),
      reference: await referenceSummary(deps, job, input.reference),
      seed: input.seed,
    },
    signal,
  );
  let planned: PlannedOption[];
  try {
    planned = parsePlan(raw);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new AiProviderError("planner answer didn't match the plan schema", true, "INVALID_PLAN");
    }
    throw error;
  }

  // 3. Each variation → motif → template-valid spec → preview.
  const stored: string[] = [];
  const put = async (data: Buffer, contentType: string, extension: string) => {
    const key = buildObjectKey(BUCKETS.designAssets, { ownerId: job.customerId, category: "ai", extension });
    await storage.put(BUCKETS.designAssets, key, data, contentType);
    stored.push(key);
    return key;
  };
  const validation = {
    productId: context.template.productId,
    templateId: context.template.templateId,
    availableSizes: context.availableSizes,
    customerId: job.customerId,
    template: context.template.config,
  };

  try {
    const options: (Omit<StoredOption, "spec"> & { spec: DesignSpec })[] = [];
    const previewKeys: string[] = [];
    for (const [index, option] of planned.entries()) {
      throwIfAborted(signal);
      let motifKey: string | null = null;
      const motif = option.variation.motif;
      if (motif && constraints.layersAllowed && !findBrandTerm(motif.prompt)) {
        let bytes: Buffer | null;
        try {
          bytes = await providers.image.generateMotif({ prompt: motif.prompt, color: motif.color, seed: motifSeed(input.seed, index) }, signal);
        } catch (error) {
          // A refused motif (e.g. an over-eager safety filter) costs the option its motif, not the
          // whole round. Transient failures (rate limits, outages, timeouts) still retry the job.
          if (error instanceof AiProviderError && !error.retryable) {
            deps.log?.("ai.motif_skipped", { jobId: job.id, option: index, code: error.code });
            bytes = null;
          } else {
            throw error;
          }
        }
        if (bytes) {
          let image;
          try {
            image = await processImage(await knockOutWhite(bytes), "aiMotif");
          } catch (error) {
            if (error instanceof ImageValidationError) {
              throw new AiProviderError("image provider returned an unusable image", true);
            }
            throw error;
          }
          motifKey = await put(image.data, image.contentType, image.extension);
        }
      }

      const spec = variationToSpec(base, option.variation, { ...validation, motifKey });
      if (!spec) {
        continue;
      }
      const usesMotif = motifKey !== null && spec.layers.some((l) => l.kind === "image" && l.image.assetKey === motifKey);
      const preview = await renderPreview(normalizeForRender(spec, context.template.config), "front", storageAssets(storage), OPTION_PREVIEW_WIDTH);
      previewKeys.push(await put(preview, "image/png", "png"));
      options.push({ title: option.title, summary: option.summary, spec, motifKey: usesMotif ? motifKey : null });
    }
    if (options.length === 0) {
      throw new AiProviderError("no variation fitted the template", true, "INVALID_PLAN");
    }
    throwIfAborted(signal);

    // 4. Save the round and finish the job together, only while this worker still holds the lease.
    const roundId = randomUUID();
    const now = (deps.now ?? (() => new Date()))();
    await db.$transaction(async (tx) => {
      await tx.aIRound.create({
        data: {
          id: roundId,
          designId: design.id,
          customerId: job.customerId,
          instruction: input.instruction,
          attachmentKeys: input.attachmentKeys,
          optionKeys: previewKeys,
          options,
          inputHash: job.inputHash,
          generation: input.generation,
          jobId: job.id,
        },
      });
      const finished = await tx.aIJob.updateMany({
        where: leaseWhere(job, deps.workerId),
        data: { status: "SUCCEEDED", result: { roundId }, finishedAt: now, lockedAt: null, lockedBy: null, error: null, errorCode: null },
      });
      if (finished.count !== 1) {
        throw new LostLease();
      }
    });
    // Motifs of variations that were dropped or didn't keep their motif aren't referenced anywhere.
    const used = new Set(options.flatMap((o) => (o.motifKey ? [o.motifKey] : [])));
    const unused = stored.filter((key) => !previewKeys.includes(key) && !used.has(key));
    stored.length = 0;
    await storage.remove(BUCKETS.designAssets, unused).catch(() => undefined);
    deps.log?.("ai.round_saved", { jobId: job.id, roundId, options: options.length, attachments: images.length });
  } catch (error) {
    // Unused motifs from dropped variations are cleaned up with everything else on failure.
    await storage.remove(BUCKETS.designAssets, stored).catch(() => undefined);
    throw error;
  }
}
