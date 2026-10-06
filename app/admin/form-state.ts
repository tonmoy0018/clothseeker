import { z } from "zod";

import { AdminError } from "@/lib/admin/errors";
import { ForbiddenError } from "@/lib/auth/policy";

export type FormState = { error?: string; ok?: string; fieldErrors?: Record<string, string> };

/** Maps expected service failures to a form message; anything else is a bug and is rethrown. */
export function toFormState(error: unknown): FormState {
  if (error instanceof AdminError) {
    return { error: error.message };
  }
  if (error instanceof ForbiddenError) {
    return { error: "You don't have permission to do that." };
  }
  if (error instanceof z.ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of error.issues) {
      const key = issue.path.join(".");
      fieldErrors[key] ??= issue.message;
    }
    return { error: error.issues[0]?.message ?? "Check the highlighted fields.", fieldErrors };
  }
  throw error;
}

export function field(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" ? value : undefined;
}

/** Reads an uploaded file from a form, rejecting oversize bodies before buffering them. */
export async function fileBytes(formData: FormData, key: string, maxBytes: number): Promise<Uint8Array | FormState> {
  const value = formData.get(key);
  if (!(value instanceof File) || value.size === 0) {
    return { error: "Choose an image to upload." };
  }
  if (value.size > maxBytes) {
    return { error: "Images must be 4 MB or smaller." };
  }
  return new Uint8Array(await value.arrayBuffer());
}
