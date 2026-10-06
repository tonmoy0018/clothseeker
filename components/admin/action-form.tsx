"use client";

import { useActionState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

import type { FormState } from "@/app/admin/form-state";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

/** A server-action form that shows the action's error/success message. */
export function ActionForm({
  action,
  children,
  className,
  messageClassName,
}: {
  action: Action;
  children: ReactNode;
  className?: string;
  messageClassName?: string;
}) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className={className}>
      {children}
      {(state.error || state.ok) && (
        <p
          role={state.error ? "alert" : "status"}
          className={cn("text-sm", state.error ? "text-destructive" : "text-emerald-700 dark:text-emerald-400", messageClassName)}
        >
          {state.error ?? state.ok}
        </p>
      )}
    </form>
  );
}

export function SubmitButton({
  children,
  pendingLabel = "Saving…",
  variant,
  size,
  className,
  name,
  value,
}: {
  children: ReactNode;
  pendingLabel?: string;
  variant?: "default" | "outline" | "secondary" | "ghost" | "destructive" | "link";
  size?: "default" | "sm" | "lg" | "xs";
  className?: string;
  name?: string;
  value?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} variant={variant} size={size} className={className} name={name} value={value}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
