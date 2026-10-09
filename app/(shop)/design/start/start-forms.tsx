"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { downscalePhoto } from "@/lib/media/client-resize";
import { cn } from "@/lib/utils";

import { getStartStatusAction, startFromDescriptionAction, startFromPhotoAction, type StartResult } from "./actions";

// Two ways to start: a dress photo or a description. Both queue a dress match for the worker, then
// open the design screen on the matched dress (with an AI round running for descriptions).

const POLL_MS = 1500;
const GIVE_UP_MS = 8 * 60 * 1000;

type Phase = { kind: "idle" } | { kind: "waiting"; jobId: string; mode: "photo" | "description" } | { kind: "error"; message: string };

const EXAMPLES = ["A flowy floral midi for a summer wedding", "A simple black dress with long sleeves for work", "A bright tiered dress for a beach holiday"];

export function StartForms({ signedIn }: { signedIn: boolean }) {
  const router = useRouter();
  const [description, setDescription] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [pending, startTransition] = useTransition();

  const signIn = () => router.push(`/login?next=${encodeURIComponent("/design/start")}`);

  useEffect(() => () => (preview ? URL.revokeObjectURL(preview) : undefined), [preview]);

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
      const response = await getStartStatusAction(waitingJob).catch(() => null);
      if (cancelled) return;
      if (!response || response.status !== "ok") {
        setPhase({ kind: "error", message: response?.status === "error" ? response.message : "We lost track of that request. Please try again." });
        return;
      }
      const job = response.job;
      if (job.state === "done") {
        const { designId, productId, alternatives, roundJobId } = job.result;
        const params = new URLSearchParams({ design: designId });
        if (roundJobId) params.set("job", roundJobId);
        if (alternatives.length > 0) params.set("alts", alternatives.join(","));
        router.push(`/customize/${productId}?${params.toString()}`);
        return;
      }
      if (job.state === "failed") {
        setPhase({ kind: "error", message: job.message });
        return;
      }
      if (Date.now() - startedAt > GIVE_UP_MS) {
        setPhase({ kind: "error", message: "This is taking longer than usual. Please try again later." });
        return;
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    timer = setTimeout(() => void tick(), 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [waitingJob, router]);

  function handle(result: StartResult, mode: "photo" | "description") {
    if (result.status === "signin") {
      signIn();
      return;
    }
    if (result.status === "error") {
      setPhase({ kind: "error", message: result.message });
      return;
    }
    setPhase({ kind: "waiting", jobId: result.jobId, mode });
  }

  function startFromPhoto(file: File) {
    if (!signedIn) {
      signIn();
      return;
    }
    setPhase({ kind: "idle" });
    startTransition(async () => {
      try {
        const blob = await downscalePhoto(file);
        setPreview(URL.createObjectURL(blob));
        const form = new FormData();
        form.set("photo", blob, "dress.jpg");
        handle(await startFromPhotoAction(form), "photo");
      } catch (error) {
        setPhase({ kind: "error", message: error instanceof Error ? error.message : "That photo couldn't be used." });
      }
    });
  }

  function startFromDescription() {
    if (!signedIn) {
      signIn();
      return;
    }
    setPhase({ kind: "idle" });
    startTransition(async () => handle(await startFromDescriptionAction(description), "description"));
  }

  const busy = pending || phase.kind === "waiting";

  return (
    <div className="flex flex-col gap-4">
      {!signedIn && <p className="text-sm text-muted-foreground">You&apos;ll be asked to sign in first.</p>}
      <div className="grid gap-4 md:grid-cols-2">
        <section className="flex flex-col gap-3 rounded-xl border p-5" data-testid="start-photo">
          <h2 className="font-medium">From a dress photo</h2>
          <p className="text-sm text-muted-foreground">Upload a photo of a dress you like. We match it to our closest dress and copy its main colors and style.</p>
          <label className={cn("inline-flex h-9 w-fit cursor-pointer items-center rounded-lg border px-3 text-sm hover:bg-muted", busy && "pointer-events-none opacity-50")}>
            {phase.kind === "waiting" && phase.mode === "photo" ? "Matching…" : "Upload a dress photo"}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              aria-label="Upload a dress photo"
              disabled={busy}
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.value = "";
                if (file) startFromPhoto(file);
              }}
            />
          </label>
          {preview && phase.kind === "waiting" && phase.mode === "photo" && (
            <span className="relative block h-40 w-28 overflow-hidden rounded-lg bg-muted">
              <Image src={preview} alt="Your dress photo" fill unoptimized className="object-cover" />
            </span>
          )}
          <p className="text-xs text-muted-foreground">JPEG, PNG or WebP up to 10 MB. Clothing brand logos can&apos;t be used.</p>
        </section>

        <section className="flex flex-col gap-3 rounded-xl border p-5" data-testid="start-description">
          <h2 className="font-medium">From a description</h2>
          <p className="text-sm text-muted-foreground">Describe the dress. We pick the best match and the AI design box suggests four ideas (uses one of today&apos;s AI rounds).</p>
          <textarea
            aria-label="Describe the dress"
            value={description}
            maxLength={500}
            rows={3}
            placeholder="e.g. A flowy floral midi for a summer wedding"
            onChange={(e) => setDescription(e.target.value)}
            className="rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((example) => (
              <button key={example} type="button" onClick={() => setDescription(example)} className="rounded-full border px-2.5 py-1 text-xs hover:bg-muted">
                {example}
              </button>
            ))}
          </div>
          <Button className="self-start" onClick={startFromDescription} disabled={busy || description.trim().length < 10}>
            {phase.kind === "waiting" && phase.mode === "description" ? "Finding your dress…" : "Find my dress"}
          </Button>
        </section>
      </div>

      {phase.kind === "waiting" && (
        <p role="status" className="text-sm text-muted-foreground" data-testid="start-waiting">
          {phase.mode === "photo" ? "Matching your photo to our dresses…" : "Finding the best dress for your description…"}
        </p>
      )}
      {phase.kind === "error" && (
        <p role="alert" className="text-sm text-destructive" data-testid="start-error">
          {phase.message}
        </p>
      )}
    </div>
  );
}
