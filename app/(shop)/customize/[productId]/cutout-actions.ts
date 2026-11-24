"use server";

import { getCurrentUser } from "@/lib/auth/session";
import { createCutout, CutoutServiceError, listCutouts, listCutoutSources, type CutoutSource, type CutoutView } from "@/lib/cutouts/service";
import { getPrisma } from "@/lib/db";
import { getStorage } from "@/lib/storage/supabase";

// "Take a decoration from another dress". Arguments come from our editor but are untrusted: the
// service checks the role, the source product, the box, the colours and the daily limit.

export type CutoutsResult = { status: "ok"; sources: CutoutSource[]; cutouts: CutoutView[]; left: number } | { status: "signin" } | { status: "error"; message: string };
export type CutoutResult = { status: "ok"; cutout: CutoutView } | { status: "signin" } | { status: "error"; message: string };

async function customer() {
  const user = await getCurrentUser();
  return user?.role === "CUSTOMER" ? user : null;
}

/** The dresses to take from, and the customer's earlier cut-outs. */
export async function loadCutoutsAction(): Promise<CutoutsResult> {
  const user = await customer();
  if (!user) {
    return { status: "signin" };
  }
  const db = getPrisma();
  const storage = getStorage();
  const [sources, mine] = await Promise.all([listCutoutSources(db, storage, user), listCutouts(db, storage, user)]);
  return { status: "ok", sources, cutouts: mine.cutouts, left: mine.left };
}

export async function createCutoutAction(input: unknown): Promise<CutoutResult> {
  const user = await customer();
  if (!user) {
    return { status: "signin" };
  }
  try {
    return { status: "ok", cutout: await createCutout(getPrisma(), getStorage(), user, input) };
  } catch (error) {
    if (error instanceof CutoutServiceError) {
      return { status: "error", message: error.message };
    }
    throw error;
  }
}
