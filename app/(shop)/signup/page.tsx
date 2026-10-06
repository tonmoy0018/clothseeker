import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { safeNextPath } from "@/lib/auth/safe-next";
import { getCurrentUser } from "@/lib/auth/session";

import { AuthForm } from "../auth-form";

export const metadata: Metadata = { title: "Create account — ClothSeeker" };

export default async function SignUpPage({ searchParams }: PageProps<"/signup">) {
  const next = safeNextPath((await searchParams).next);
  if (await getCurrentUser()) {
    redirect(next);
  }
  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-6 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Create your account</h1>
        <p className="text-sm text-muted-foreground">Shop dresses and track your orders.</p>
      </div>
      <AuthForm mode="sign-up" next={next} />
    </div>
  );
}
