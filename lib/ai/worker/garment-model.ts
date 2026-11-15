import { checkGlb, GlbError } from "@/lib/model3d/glb";
import { garmentModelPayloadSchema } from "@/lib/model3d/payload";
import { BUCKETS } from "@/lib/storage/buckets";
import { buildObjectKey } from "@/lib/storage/object-key";

import { AiJobRejected, AiProviderError } from "../errors";

import { leaseWhere, LostLease, type ClaimedJob } from "./claim";
import { garmentImage } from "./try-on";
import type { AiWorkerDeps } from "./run";

// One 3D view, run by the worker:
//   the garment alone on a transparent backdrop (as for a try-on) → GarmentModelProvider → checkGlb
//   → stored under the customer's models/ → job SUCCEEDED with { modelKey } (only while holding the lease).

export async function runGarmentModel(deps: AiWorkerDeps, job: ClaimedJob, signal: AbortSignal): Promise<void> {
  const { db, storage, providers } = deps;
  const parsed = garmentModelPayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    throw new AiJobRejected("INTERNAL");
  }
  const builder = providers.garmentModel;
  if (!builder) {
    throw new AiJobRejected("NOT_AVAILABLE");
  }
  const garment = await garmentImage(deps, job, parsed.data.source, parsed.data.garmentHash);
  if (signal.aborted) {
    throw new AiProviderError("job aborted", true, "TIMEOUT");
  }

  // Provider output is untrusted: only a self-contained GLB within the limits is stored.
  const model = await builder.buildModel({ data: garment.cutout, mimeType: "image/png" }, signal);
  let summary;
  try {
    summary = checkGlb(model);
  } catch (error) {
    if (error instanceof GlbError) {
      throw new AiProviderError(`3D model provider returned an unusable model (${error.message})`, true);
    }
    throw error;
  }
  if (signal.aborted) {
    throw new AiProviderError("job aborted", true, "TIMEOUT");
  }

  const modelKey = buildObjectKey(BUCKETS.designAssets, { ownerId: job.customerId, category: "models", extension: "glb" });
  await storage.put(BUCKETS.designAssets, modelKey, model, "model/gltf-binary");
  try {
    const finished = await db.aIJob.updateMany({
      where: leaseWhere(job, deps.workerId),
      data: { status: "SUCCEEDED", result: { modelKey }, finishedAt: (deps.now ?? (() => new Date()))(), lockedAt: null, lockedBy: null, error: null, errorCode: null },
    });
    if (finished.count !== 1) {
      throw new LostLease();
    }
    deps.log?.("ai.model3d_saved", { jobId: job.id, provider: builder.name, bytes: summary.bytes, vertices: summary.vertices });
  } catch (error) {
    await storage.remove(BUCKETS.designAssets, [modelKey]).catch(() => undefined);
    throw error;
  }
}
