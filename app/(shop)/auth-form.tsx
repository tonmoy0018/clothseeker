"use client";

import Link from "next/link";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { signIn, signUp, type AuthFormState } from "./auth-actions";

const initial: AuthFormState = {};

export function AuthForm({ mode, next }: { mode: "sign-in" | "sign-up"; next: string }) {
  const [state, action, pending] = useActionState(mode === "sign-in" ? signIn : signUp, initial);
  const isSignUp = mode === "sign-up";
  const switchHref = `${isSignUp ? "/login" : "/signup"}?next=${encodeURIComponent(next)}`;

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      {isSignUp && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" autoComplete="name" required maxLength={80} />
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required maxLength={254} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete={isSignUp ? "new-password" : "current-password"}
          required
          minLength={isSignUp ? 8 : 1}
          maxLength={72}
        />
        {isSignUp && <p className="text-xs text-muted-foreground">At least 8 characters.</p>}
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      {state.notice && (
        <p role="status" className="text-sm">
          {state.notice}
        </p>
      )}
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "Please wait…" : isSignUp ? "Create account" : "Sign in"}
      </Button>
      <p className="text-sm text-muted-foreground">
        {isSignUp ? "Already have an account?" : "New to ClothSeeker?"}{" "}
        <Link href={switchHref} className="text-foreground underline underline-offset-4">
          {isSignUp ? "Sign in" : "Create an account"}
        </Link>
      </p>
    </form>
  );
}
