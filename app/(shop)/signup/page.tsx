import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { safeNextPath } from "@/lib/auth/safe-next";
import { getCurrentUser } from "@/lib/auth/session";

import { AuthForm } from "../_auth/auth-form";

export const metadata: Metadata = { title: "Create account — ClothSeeker" };

export default async function SignUpPage({ searchParams }: PageProps<"/signup">) {
  const next = safeNextPath((await searchParams).next);
  if (await getCurrentUser()) {
    redirect(next);
  }
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 rounded-3xl border bg-card p-6 shadow-sm sm:my-6 sm:p-10">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-3xl font-semibold">Create your account</h1>
        <p className="text-sm text-muted-foreground">Shop, design your own and track your orders.</p>
      </div>
      <AuthForm mode="sign-up" next={next} />
    </div>
  );
}
