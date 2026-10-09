"use client";

import Image from "next/image";
import { useEffect, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { downscalePhoto } from "@/lib/media/client-resize";
import { isTryOnStale, TRYON_CONSENT_POINTS } from "@/lib/tryon/rules";
import type { TryOnPhotoView, TryOnResultView } from "@/lib/tryon/service";
import { cn } from "@/lib/utils";
import type { DesignSpec } from "@/types/design-spec";

import {
  deletePhotoAction,
  getTryOnOverviewAction,
  getTryOnStatusAction,
  savePhotoAction,
  saveResultAction,
  startTryOnAction,
  uploadTryOnPhotoAction,
  type TryOnQuotaView,
} from "./try-on-actions";

// Virtual try-on: consent → photo → queued try-on → before/after. A design edit marks the result as
// out of date, but only "Update try-on" reruns it — never automatically.

const POLL_MS = 2000;
const POLL_GIVE_UP_MS = 12 * 60 * 1000;

export type TryOnSource = { kind: "design"; spec: DesignSpec; designId: string | null } | { kind: "product"; productId: string };

type Phase = { kind: "idle" } | { kind: "waiting"; jobId: string; running: boolean } | { kind: "error"; message: string };

export function TryOnPanel({ source, signedIn, onSignIn }: { source: TryOnSource; signedIn: boolean; onSignIn: () => void }) {
  const [photos, setPhotos] = useState<TryOnPhotoView[]>([]);
  const [photoId, setPhotoId] = useState<string | null>(null);
  const [quota, setQuota] = useState<TryOnQuotaView | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [result, setResult] = useState<TryOnResultView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const loaded = useRef(false);

  useEffect(() => {
    if (!signedIn || loaded.current) {
      return;
    }
    loaded.current = true;
    void getTryOnOverviewAction().then((overview) => {
      setPhotos(overview.photos);
      setQuota(overview.quota);
      setPhotoId((current) => current ?? overview.photos[0]?.id ?? null);
    });
  }, [signedIn]);

  const waitingJob = phase.kind === "waiting" ? phase.jobId : null;
  useEffect(() => {
    if (!waitingJob) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    const tick = async () => {
      if (cancelled) return;
      const response = await getTryOnStatusAction(waitingJob).catch(() => null);
      if (cancelled) return;
      if (!response || response.status !== "ok") {
        setPhase({ kind: "error", message: response?.status === "error" ? response.message : "We lost track of that try-on. Please try again." });
        return;
      }
      const job = response.job;
      if (job.state === "done") {
        setResult(job.result);
        setPhase({ kind: "idle" });
        return;
      }
      if (job.state === "failed") {
        setPhase({ kind: "error", message: job.message });
        return;
      }
      if (Date.now() - startedAt > POLL_GIVE_UP_MS) {
        setPhase({ kind: "error", message: "The try-on service is very busy right now. Please try again later." });
        return;
      }
      setPhase((p) => (p.kind === "waiting" && p.jobId === waitingJob ? { ...p, running: job.position === "running" } : p));
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    timer = setTimeout(() => void tick(), 800);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [waitingJob]);

  async function upload(file: File) {
    if (!signedIn) {
      onSignIn();
      return;
    }
    setUploading(true);
    setPhase({ kind: "idle" });
    try {
      const form = new FormData();
      form.set("photo", await downscalePhoto(file), "photo.jpg");
      form.set("consent", agreed ? "yes" : "no");
      const response = await uploadTryOnPhotoAction(form);
      if (response.status === "signin") {
        onSignIn();
        return;
      }
      if (response.status === "error") {
        setPhase({ kind: "error", message: response.message });
        return;
      }
      setPhotos((list) => [response.photo, ...list]);
      setPhotoId(response.photo.id);
    } catch (error) {
      setPhase({ kind: "error", message: error instanceof Error ? error.message : "That photo couldn't be added." });
    } finally {
      setUploading(false);
    }
  }

  function start() {
    if (!photoId) return;
    setNotice(null);
    const input =
      source.kind === "design" ? { photoId, source: { kind: "design", spec: source.spec, designId: source.designId } } : { photoId, source: { kind: "product", productId: source.productId } };
    startTransition(async () => {
      const response = await startTryOnAction(input);
      if (response.status === "signin") {
        onSignIn();
        return;
      }
      if (response.status === "error") {
        setPhase({ kind: "error", message: response.message });
        return;
      }
      setQuota(response.quota);
      if (response.cached) {
        setNotice("You already tried this on with this photo, so here it is again (this didn't use a try-on).");
      }
      setPhase({ kind: "waiting", jobId: response.jobId, running: false });
    });
  }

  function applySaved(kind: "photo" | "result", id: string, saved: boolean) {
    if (kind === "photo") {
      setPhotos((list) => list.map((p) => (p.id === id ? { ...p, saved } : p)));
      setResult((r) => (r && r.photoId === id ? { ...r, photoSaved: saved } : r));
    } else {
      setResult((r) => (r && r.id === id ? { ...r, saved } : r));
    }
  }

  /** Optimistic: the checkbox flips at once and flips back if the server refuses. */
  function toggleSaved(kind: "photo" | "result", id: string, saved: boolean) {
    applySaved(kind, id, saved);
    startTransition(async () => {
      const response = kind === "photo" ? await savePhotoAction(id, saved) : await saveResultAction(id, saved);
      if (response.status !== "ok") {
        applySaved(kind, id, !saved);
        setPhase({ kind: "error", message: response.status === "error" ? response.message : "Please sign in again." });
      }
    });
  }

  function deletePhoto(id: string) {
    startTransition(async () => {
      const response = await deletePhotoAction(id);
      if (response.status !== "ok") {
        setPhase({ kind: "error", message: response.status === "error" ? response.message : "Please sign in again." });
        return;
      }
      setPhotos((list) => list.filter((p) => p.id !== id));
      setPhotoId((current) => (current === id ? null : current));
      setResult((r) => (r && r.photoId === id ? null : r));
      setNotice("Photo and its try-ons deleted.");
    });
  }

  const busy = pending || uploading || phase.kind === "waiting";
  const stale = result !== null && source.kind === "design" && isTryOnStale(result.garmentHash, source.spec);
  const selected = photos.find((p) => p.id === photoId) ?? null;

  if (!signedIn) {
    return (
      <section className="flex flex-col gap-2 rounded-xl border p-4" data-testid="try-on-panel">
        <h2 className="font-medium">See it on me</h2>
        <p className="text-sm text-muted-foreground">Sign in to try dresses on with your own photo.</p>
        <Button variant="outline" className="self-start" onClick={onSignIn}>
          Sign in to try on
        </Button>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3 rounded-xl border p-4" data-testid="try-on-panel" aria-labelledby="try-on-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="try-on-title" className="font-medium">
          See it on me
        </h2>
        {quota && (
          <span className="text-xs text-muted-foreground" data-testid="try-on-quota">
            {quota.remaining} of {quota.limit} try-ons left today
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">Rough AI preview: the real dress will fit and look different.</p>

      {/* Consent comes before any upload. */}
      <div className="flex flex-col gap-2 rounded-lg bg-muted/50 p-3 text-sm" data-testid="try-on-consent">
        <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
          {TRYON_CONSENT_POINTS.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
        <label className="flex items-center gap-2">
          <input type="checkbox" className="size-4" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />I agree to use my photo for try-on
        </label>
        <label className={cn("inline-flex h-8 w-fit cursor-pointer items-center rounded-lg border bg-background px-3 hover:bg-muted", (!agreed || busy) && "pointer-events-none opacity-50")}>
          {uploading ? "Uploading…" : "Upload a photo of me"}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            aria-label="Upload a photo of me"
            disabled={!agreed || busy}
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (file) void upload(file);
            }}
          />
        </label>
        <p className="text-xs text-muted-foreground">Best: just you, facing the camera, in good light, shoulders to knees visible.</p>
      </div>

      {photos.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-sm">Your photos</span>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Your photos">
            {photos.map((p, i) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={p.id === photoId}
                aria-label={`Photo ${i + 1}${p.saved ? " (saved)" : ""}`}
                onClick={() => setPhotoId(p.id)}
                className={cn("relative h-20 w-14 overflow-hidden rounded-lg border bg-muted", p.id === photoId && "ring-2 ring-foreground")}
              >
                {p.url && <Image src={p.url} alt="" fill unoptimized className="object-cover" />}
              </button>
            ))}
          </div>
          {selected && (
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" className="size-4" checked={selected.saved} disabled={uploading || phase.kind === "waiting"} onChange={(e) => toggleSaved("photo", selected.id, e.target.checked)} />
                Keep this photo
              </label>
              {!selected.saved && <span className="text-muted-foreground">Deleted automatically after 24 hours</span>}
              <button type="button" className="text-destructive underline" disabled={busy} onClick={() => deletePhoto(selected.id)}>
                Delete photo now
              </button>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button onClick={start} disabled={!photoId || busy || quota?.remaining === 0}>
          {phase.kind === "waiting" ? "Trying on…" : result ? "Try on again" : "Try it on"}
        </Button>
      </div>

      {phase.kind === "error" && (
        <p role="alert" className="text-sm text-destructive">
          {phase.message}
        </p>
      )}
      {notice && phase.kind !== "error" && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {phase.kind === "waiting" && (
        <div className="flex aspect-[3/4] max-w-60 animate-pulse items-center justify-center rounded-lg bg-muted p-4 text-center text-xs text-muted-foreground" data-testid="try-on-loading" aria-live="polite">
          {phase.running ? "Putting the dress on you… this can take a minute." : "Waiting for the try-on service…"}
        </div>
      )}

      {result && phase.kind !== "waiting" && (
        <div className="flex flex-col gap-2" data-testid="try-on-result">
          {stale && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-sm dark:bg-amber-950/30" data-testid="try-on-stale">
              Your design changed since this try-on.
              <Button size="sm" variant="outline" onClick={start} disabled={busy || !photoId}>
                Update try-on
              </Button>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <figure className="flex flex-col gap-1">
              <div className="relative aspect-[3/4] overflow-hidden rounded-lg bg-muted">
                {result.photoUrl && <Image src={result.photoUrl} alt="Your photo" fill unoptimized className="object-cover" />}
              </div>
              <figcaption className="text-xs text-muted-foreground">Before</figcaption>
            </figure>
            <figure className="flex flex-col gap-1">
              <div className="relative aspect-[3/4] overflow-hidden rounded-lg bg-muted">
                {result.imageUrl && <Image src={result.imageUrl} alt="You wearing this dress (AI preview)" fill unoptimized className="object-cover" />}
              </div>
              <figcaption className="text-xs text-muted-foreground">After (AI preview)</figcaption>
            </figure>
          </div>
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" className="size-4" checked={result.saved} onChange={(e) => toggleSaved("result", result.id, e.target.checked)} />
            Keep this try-on {result.saved ? "" : "(otherwise deleted after 24 hours)"}
          </label>
        </div>
      )}
    </section>
  );
}
