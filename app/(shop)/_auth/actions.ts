"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { safeNextPath } from "@/lib/auth/safe-next";
import { getPrisma } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type AuthFormState = { error?: string; notice?: string };

const email = z.email("Enter a valid email address").max(254).transform((v) => v.trim().toLowerCase());
const password = z.string().min(8, "Password must be at least 8 characters").max(72);

const signInSchema = z.object({ email, password: z.string().min(1).max(72), next: z.string().optional() });

const signUpSchema = z.object({
  name: z.string().trim().min(1, "Enter your name").max(80),
  email,
  password,
  next: z.string().optional(),
});

function field(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" ? value : undefined;
}

export async function signIn(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const parsed = signInSchema.safeParse({
    email: field(formData, "email"),
    password: field(formData, "password"),
    next: field(formData, "next"),
  });
  if (!parsed.success) {
    return { error: "Enter your email and password." };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error || !data.user) {
    // Same message for unknown email and wrong password, to avoid account enumeration.
    return { error: "Email or password is incorrect." };
  }

  const profile = await getPrisma().user.findUnique({ where: { id: data.user.id }, select: { role: true } });
  const fallback = profile?.role === "ADMIN" ? "/admin" : "/";
  redirect(safeNextPath(parsed.data.next, fallback));
}

export async function signUp(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const parsed = signUpSchema.safeParse({
    name: field(formData, "name"),
    email: field(formData, "email"),
    password: field(formData, "password"),
    next: field(formData, "next"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form and try again." };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error || !data.user) {
    return { error: "We couldn't create that account. Try a different email, or sign in." };
  }

  // Sign-up always creates a customer. Admin accounts are only created by the seed/admin tooling.
  try {
    await getPrisma().user.upsert({
      where: { id: data.user.id },
      create: { id: data.user.id, email: parsed.data.email, name: parsed.data.name, role: "CUSTOMER" },
      update: {},
    });
  } catch {
    return { error: "We couldn't create that account. Try a different email, or sign in." };
  }

  if (!data.session) {
    return { notice: "Check your email to confirm your account, then sign in." };
  }
  redirect(safeNextPath(parsed.data.next));
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/");
}
