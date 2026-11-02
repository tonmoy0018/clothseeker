import { assertCustomer, type Actor } from "@/lib/auth/policy";
import type { PrismaClient } from "@/lib/db/client";

import { fitInputSchema, type FitInput } from "./fit";

// A customer's remembered height, weight and fit preference (body_profiles), kept only when they tick
// "Remember on my account". Personal data: only the owner reads or changes it, it's deleted on request
// or with the account, and it's never logged.

export class FitProfileError extends Error {
  override readonly name = "FitProfileError";
}

export async function getBodyProfile(db: Pick<PrismaClient, "bodyProfile">, actor: Actor): Promise<FitInput | null> {
  assertCustomer(actor);
  const row = await db.bodyProfile.findUnique({ where: { userId: actor.id }, select: { heightCm: true, weightKg: true, fitPreference: true } });
  return row ? { heightCm: row.heightCm, weightKg: row.weightKg, preference: row.fitPreference } : null;
}

export async function saveBodyProfile(db: Pick<PrismaClient, "bodyProfile">, actor: Actor, rawInput: unknown): Promise<FitInput> {
  assertCustomer(actor);
  const parsed = fitInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new FitProfileError(parsed.error.issues[0]?.message ?? "Check your height and weight.");
  }
  const { heightCm, weightKg, preference } = parsed.data;
  const data = { heightCm, weightKg, fitPreference: preference };
  await db.bodyProfile.upsert({ where: { userId: actor.id }, create: { userId: actor.id, ...data }, update: data });
  return parsed.data;
}

export async function deleteBodyProfile(db: Pick<PrismaClient, "bodyProfile">, actor: Actor): Promise<void> {
  assertCustomer(actor);
  await db.bodyProfile.deleteMany({ where: { userId: actor.id } });
}
