import "server-only";

import { cache } from "react";
import { z } from "zod";

import { getPrisma } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import type { Role } from "@/lib/generated/prisma/enums";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type CurrentUser = {
  id: string;
  email: string;
  name: string | null;
  role: Role;
};

const claimsSchema = z.object({
  sub: z.uuid(),
  email: z.email().optional(),
});

const userSelect = { id: true, email: true, name: true, role: true } as const;

/**
 * The signed-in user for this request, or null. The role always comes from our `users`
 * table — never from the JWT or the client. Cached per request.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data) {
    return null;
  }
  const claims = claimsSchema.safeParse(data.claims);
  if (!claims.success) {
    return null;
  }

  const prisma = getPrisma();
  const existing = await prisma.user.findUnique({ where: { id: claims.data.sub }, select: userSelect });
  if (existing) {
    return existing;
  }
  if (!claims.data.email) {
    return null;
  }

  // First request after sign-up: create the profile. New accounts are always customers.
  try {
    return await prisma.user.upsert({
      where: { id: claims.data.sub },
      create: { id: claims.data.sub, email: claims.data.email.toLowerCase(), role: "CUSTOMER" },
      update: {},
      select: userSelect,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // Email already belongs to a different profile; refuse rather than merge accounts.
      return null;
    }
    throw error;
  }
});
