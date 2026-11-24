"use server";

import { getCurrentUser } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db";
import { createGarmentModelJob, getGarmentModelStatus, Model3dError, type GarmentModelStatus } from "@/lib/model3d/service";
import { getStorage } from "@/lib/storage/supabase";

// The 3D view's actions, shared by the design screen and product pages. They only queue work and read
// its result; the worker makes the model. Arguments are untrusted and re-validated in lib/model3d.

type Failure = { status: "signin" } | { status: "error"; message: string };

export type StartModelResult = { status: "queued"; jobId: string } | Failure;

export async function startGarmentModelAction(source: unknown): Promise<StartModelResult> {
  const user = await getCurrentUser();
  if (!user) {
    return { status: "signin" };
  }
  if (user.role !== "CUSTOMER") {
    return { status: "error", message: "The 3D view is for customer accounts." };
  }
  try {
    const { jobId } = await createGarmentModelJob(getPrisma(), getStorage(), user, { source });
    return { status: "queued", jobId };
  } catch (error) {
    if (error instanceof Model3dError) {
      return { status: "error", message: error.message };
    }
    throw error;
  }
}

export async function getGarmentModelStatusAction(jobId: unknown): Promise<GarmentModelStatus | Failure> {
  const user = await getCurrentUser();
  if (!user) {
    return { status: "signin" };
  }
  try {
    return await getGarmentModelStatus(getPrisma(), getStorage(), user, jobId);
  } catch (error) {
    if (error instanceof Model3dError) {
      return { status: "error", message: error.message };
    }
    throw error;
  }
}
