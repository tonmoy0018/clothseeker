"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { MAX_DISPUTE_PHOTOS } from "@/lib/disputes/rules";
import { downscalePhoto } from "@/lib/media/client-resize";

import { reportProblemAction, type ReportState } from "./dispute-actions";

const initial: ReportState = { error: null, done: false };
const deadlineFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "Asia/Dhaka" });

/** A delivered item that isn't right: describe the problem and add photos. */
export function ReportProblem({ orderId, itemId, deadline }: { orderId: string; itemId: string; deadline: Date }) {
  const [open, setOpen] = useState(false);
  const [photos, setPhotos] = useState<Blob[]>([]);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [state, action, pending] = useActionState(async (prev: ReportState, form: FormData) => {
    form.delete("photos");
    photos.forEach((p, i) => form.append("photos", p, `photo-${i + 1}.jpg`));
    return reportProblemAction(prev, form);
  }, initial);

  if (state.done) {
    return null;
  }
  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Report a problem
        </Button>
        <span className="text-xs text-muted-foreground">Until {deadlineFormat.format(deadline)}</span>
      </div>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-2 rounded-lg border p-3 text-sm" data-testid="report-problem">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="itemId" value={itemId} />
      <label className="flex flex-col gap-1">
        What&apos;s wrong?
        <textarea
          name="reason"
          rows={3}
          maxLength={1000}
          required
          placeholder="e.g. The skirt colour is much darker than my design, and a seam is open on the left side"
          className="rounded-lg border border-input bg-transparent px-2.5 py-2 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      </label>
      <label className="flex flex-col gap-1">
        Photos (up to {MAX_DISPUTE_PHOTOS})
        <input
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp"
          aria-label="Photos of the problem"
          onChange={async (e) => {
            const files = Array.from(e.currentTarget.files ?? []).slice(0, MAX_DISPUTE_PHOTOS);
            setPhotoError(null);
            try {
              setPhotos(await Promise.all(files.map(downscalePhoto)));
            } catch (error) {
              setPhotoError(error instanceof Error ? error.message : "A photo couldn't be used.");
            }
          }}
        />
      </label>
      {photos.length > 0 && <span className="text-xs text-muted-foreground">{photos.length} photo(s) ready</span>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Sending…" : "Send to ClothSeeker"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {(state.error ?? photoError) && (
        <p role="alert" className="text-destructive">
          {state.error ?? photoError}
        </p>
      )}
    </form>
  );
}
