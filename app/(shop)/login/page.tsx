import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { safeNextPath } from "@/lib/auth/safe-next";
import { getCurrentUser } from "@/lib/auth/session";

import { AuthForm } from "../auth-form";

export const metadata: Metadata = { title: "Sign in — ClothSeeker" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const next = safeNextPath((await searchParams).next);
  if (await getCurrentUser()) {
    redirect(next);
  }
  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-6 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Sign in</h1>
        <p className="text-sm text-muted-foreground">Welcome back to ClothSeeker.</p>
      </div>
      <AuthForm mode="sign-in" next={next} />
    </div>
  );
}
