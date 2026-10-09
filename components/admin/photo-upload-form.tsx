"use client";

import { useActionState, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

import type { FormState } from "@/app/admin/form-state";
import { Button } from "@/components/ui/button";

const MAX_BYTES = 4 * 1024 * 1024;
const ACCEPT = "image/jpeg,image/png,image/webp";

function UploadButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="outline" disabled={disabled || pending}>
      {pending ? "Uploading…" : "Upload"}
    </Button>
  );
}

/** File picker with an instant size check; the server re-validates everything. */
export function PhotoUploadForm({
  action,
  hidden,
  label = "Add photo",
  hint = "JPEG, PNG or WebP, up to 4 MB, at least 600×600 px.",
  fileField = "photo",
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  hidden: Record<string, string>;
  label?: string;
  hint?: string;
  /** Form field name of the file input (read by the server action). */
  fileField?: string;
}) {
  const inputId = `upload-${hidden.slot ?? fileField}`;
  const [state, formAction] = useActionState(action, {});
  const [clientError, setClientError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <form
      action={async (formData) => {
        await formAction(formData);
        if (inputRef.current) {
          inputRef.current.value = "";
        }
      }}
      className="flex flex-col gap-2"
    >
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <label className="text-sm font-medium" htmlFor={inputId}>
        {label}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          id={inputId}
          name={fileField}
          type="file"
          accept={ACCEPT}
          required
          className="max-w-full text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1 file:text-sm"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            setClientError(file && file.size > MAX_BYTES ? "That file is larger than 4 MB." : null);
          }}
        />
        <UploadButton disabled={clientError !== null} />
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>
      {(clientError ?? state.error) && (
        <p role="alert" className="text-sm text-destructive">
          {clientError ?? state.error}
        </p>
      )}
      {!clientError && state.ok && (
        <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
          {state.ok}
        </p>
      )}
    </form>
  );
}
