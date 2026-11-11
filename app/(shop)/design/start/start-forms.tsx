"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { GARMENT_TYPE_IDS, GARMENT_TYPES, type GarmentType } from "@/lib/catalog/garment-types";
import { downscalePhoto } from "@/lib/media/client-resize";
import { cn } from "@/lib/utils";

import { getStartStatusAction, startFromDescriptionAction, startFromPhotoAction, uploadDressPhotoAction, type StartResult } from "./actions";
import { textareaClass } from "@/components/ui/textarea";

// Two ways to start: a dress photo or a description. A description, or a photo the customer wants matched
// to our closest dress, queues a dress match and opens the design screen on that dress (with an AI round
// running for descriptions). A photo can instead become the customer's own dress, to customise or to have
// made exactly as it is: both open the design screen on it, and are priced by the team through a quote.

const POLL_MS = 1500;
const GIVE_UP_MS = 8 * 60 * 1000;

type PhotoChoice = "exact" | "customize" | "closest";
type Phase = { kind: "idle" } | { kind: "waiting"; jobId: string; mode: "photo" | "description"; choice?: PhotoChoice } | { kind: "error"; message: string };

const WAITING: Record<PhotoChoice, string> = {
  exact: "Getting your own dress ready…",
  customize: "Getting your own dress ready to customise…",
  closest: "Matching your photo to our dresses…",
};

const EXAMPLES = ["A flowy floral midi for a summer wedding", "A simple black dress with long sleeves for work", "A bright tiered dress for a beach holiday"];

/**
 * `photoOnly`: just the dress-photo part, for the "Upload your dress" page (`path` is where sign-in
 * brings the customer back to).
 */
export function StartForms({ signedIn, photoOnly = false, path = "/design/start" }: { signedIn: boolean; photoOnly?: boolean; path?: string }) {
  const router = useRouter();
  const [description, setDescription] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [photoKey, setPhotoKey] = useState<string | null>(null);
  // "auto": the AI reads what it is from the photo.
  const [garmentType, setGarmentType] = useState<GarmentType | "auto">("auto");
  const noun = garmentType === "auto" ? "garment" : GARMENT_TYPES[garmentType].noun;
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [pending, startTransition] = useTransition();

  const signIn = () => router.push(`/login?next=${encodeURIComponent(path)}`);

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

  function handle(result: StartResult, mode: "photo" | "description", choice?: PhotoChoice) {
    if (result.status === "signin") {
      signIn();
      return;
    }
    if (result.status === "error") {
      setPhase({ kind: "error", message: result.message });
      return;
    }
    setPhase({ kind: "waiting", jobId: result.jobId, mode, choice });
  }

  function uploadPhoto(file: File) {
    if (!signedIn) {
      signIn();
      return;
    }
    setPhase({ kind: "idle" });
    setPhotoKey(null);
    startTransition(async () => {
      try {
        const blob = await downscalePhoto(file);
        setPreview(URL.createObjectURL(blob));
        const form = new FormData();
        form.set("photo", blob, "dress.jpg");
        const uploaded = await uploadDressPhotoAction(form);
        if (uploaded.status === "signin") {
          signIn();
        } else if (uploaded.status === "error") {
          setPhase({ kind: "error", message: uploaded.message });
        } else {
          setPhotoKey(uploaded.key);
        }
      } catch (error) {
        setPhase({ kind: "error", message: error instanceof Error ? error.message : "That photo couldn't be used." });
      }
    });
  }

  function choose(choice: PhotoChoice) {
    if (!photoKey) return;
    setPhase({ kind: "idle" });
    startTransition(async () => handle(await startFromPhotoAction(photoKey, choice, garmentType), "photo", choice));
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
      <div className={cn("grid gap-4", photoOnly ? "max-w-xl" : "md:grid-cols-2")}>
        <section className="flex flex-col gap-3 rounded-2xl border bg-card p-5" data-testid="start-photo">
          <h2 className="font-medium">From a dress photo</h2>
          <p className="text-sm text-muted-foreground">
            Upload a photo of a dress you like. We can make it exactly as it is, let you customise it, or start you from our closest dress.
          </p>
          <label className={cn("inline-flex h-9 w-fit cursor-pointer items-center rounded-lg border px-3 text-sm hover:bg-muted", busy && "pointer-events-none opacity-50")}>
            {photoKey ? "Use another photo" : "Upload a dress photo"}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              aria-label="Upload a dress photo"
              disabled={busy}
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.value = "";
                if (file) uploadPhoto(file);
              }}
            />
          </label>
          {preview && (photoKey || (phase.kind === "waiting" && phase.mode === "photo")) && (
            <span className="relative block h-40 w-28 overflow-hidden rounded-lg bg-muted">
              <Image src={preview} alt="Your dress photo" fill unoptimized className="object-cover" />
            </span>
          )}
          {photoKey && (
            <div className="flex flex-col gap-3" data-testid="photo-choices">
              <label className="flex items-center gap-2 text-sm">
                What is it?
                <select
                  className="h-8 rounded-md border bg-background px-2 text-sm"
                  value={garmentType}
                  disabled={busy}
                  onChange={(e) => setGarmentType(GARMENT_TYPE_IDS.find((t) => t === e.target.value) ?? "auto")}
                >
                  <option value="auto">Let us work it out</option>
                  {GARMENT_TYPE_IDS.map((t) => (
                    <option key={t} value={t}>
                      {GARMENT_TYPES[t].label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex flex-col gap-2">
                <ChoiceButton
                  title={`Make this exact ${noun}`}
                  detail="We make it just like your photo. See it, try it on, then ask for a price: we reply within 24 hours."
                  onClick={() => choose("exact")}
                  disabled={busy}
                />
                <ChoiceButton
                  title={`Customize this ${noun}`}
                  detail="Change its colours, add text, decorations or embroidery on your own dress, try it on, then ask for a price."
                  onClick={() => choose("customize")}
                  disabled={busy}
                />
                <ChoiceButton
                  title="Start from our closest dress"
                  detail="A ClothSeeker design in the same colours and style: priced right away, order it instantly."
                  onClick={() => choose("closest")}
                  disabled={busy}
                />
              </div>
            </div>
          )}
          <p className="text-xs text-muted-foreground">JPEG, PNG or WebP, any size. Clothing brand logos can&apos;t be used.</p>
        </section>

        {!photoOnly && (
          <section className="flex flex-col gap-3 rounded-2xl border bg-card p-5" data-testid="start-description">
            <h2 className="font-medium">From a description</h2>
            <p className="text-sm text-muted-foreground">Describe the dress. We pick the best match and the AI design box suggests four ideas (uses one of today&apos;s AI rounds).</p>
            <textarea
              aria-label="Describe the dress"
              value={description}
              maxLength={500}
              rows={3}
              placeholder="e.g. A flowy floral midi for a summer wedding"
              onChange={(e) => setDescription(e.target.value)}
              className={textareaClass}
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
        )}
      </div>

      {phase.kind === "waiting" && (
        <p role="status" className="text-sm text-muted-foreground" data-testid="start-waiting">
          {phase.mode === "photo" ? WAITING[phase.choice ?? "closest"] : "Finding the best dress for your description…"}
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

function ChoiceButton({ title, detail, onClick, disabled }: { title: string; detail: string; onClick: () => void; disabled: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="flex flex-col items-start gap-0.5 rounded-lg border p-3 text-left hover:bg-muted disabled:opacity-50">
      <span className="text-sm font-medium">{title}</span>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </button>
  );
}
