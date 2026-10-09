"use client";

import Image from "next/image";
import { useEffect, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import type { RoundView } from "@/lib/ai/jobs";
import type { AiQuota } from "@/lib/ai/quota";
import { downscalePhoto } from "@/lib/media/client-resize";
import { cn } from "@/lib/utils";
import type { DesignSpec } from "@/types/design-spec";

import { getAiOverviewAction, getJobStatusAction, pickOptionAction, requestDesignRoundAction, uploadAiAttachmentAction } from "./ai-actions";

// The AI design box: describe a change (optionally with photos), get four options, pick one or
// refine it. Work is queued for the worker; this component only polls for the outcome.

const EXAMPLES = ["Pastel florals on the skirt", "Make it evening-ready in emerald", "Like option 2 but darker"];
const MAX_PHOTOS = 3;
const POLL_MS = 2000;
/** Stop polling eventually (3 attempts with timeouts and backoff fit well inside this). */
const POLL_GIVE_UP_MS = 10 * 60 * 1000;

type Attachment = { key: string; url: string | null };
type Reference = { roundId: string; optionIndex: number };
type Phase = { kind: "idle" } | { kind: "waiting"; jobId: string; running: boolean } | { kind: "error"; message: string };

export type AiBoxProps = {
  designId: string | null;
  spec: DesignSpec;
  signedIn: boolean;
  /** The AI request created or reused a design (unsaved designs become drafts). */
  onDesignId: (designId: string) => void;
  onPick: (spec: DesignSpec, imageUrls: Record<string, string>, label: string) => void;
  onSignIn: () => void;
};

export function AiBox({ designId, spec, signedIn, onDesignId, onPick, onSignIn }: AiBoxProps) {
  const [instruction, setInstruction] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [reference, setReference] = useState<Reference | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [round, setRound] = useState<RoundView | null>(null);
  const [history, setHistory] = useState<RoundView[]>([]);
  const [quota, setQuota] = useState<AiQuota | null>(null);
  const [lastRequest, setLastRequest] = useState<{ instruction: string; attachmentKeys: string[]; reference: Reference | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const loadedFor = useRef<string | null | undefined>(undefined);

  // Quota and earlier rounds for this design.
  useEffect(() => {
    if (!signedIn || loadedFor.current === designId) {
      return;
    }
    loadedFor.current = designId;
    let cancelled = false;
    void getAiOverviewAction(designId).then((overview) => {
      if (!cancelled) {
        setQuota(overview.quota);
        setHistory(overview.rounds);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [designId, signedIn]);

  // Poll the queued job until it finishes (stops when the page is left).
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
      const result = await getJobStatusAction(waitingJob).catch(() => null);
      if (cancelled) return;
      if (!result || result.status !== "ok") {
        setPhase({ kind: "error", message: result?.status === "error" ? result.message : "We lost track of that request. Please try again." });
        return;
      }
      const job = result.job;
      if (job.state === "done") {
        setRound(job.round);
        setHistory((h) => [job.round, ...h.filter((r) => r.id !== job.round.id)]);
        setPhase({ kind: "idle" });
        return;
      }
      if (job.state === "failed") {
        setPhase({ kind: "error", message: job.message });
        return;
      }
      if (Date.now() - startedAt > POLL_GIVE_UP_MS) {
        setPhase({ kind: "error", message: "The design helper is very busy right now. Please try again later." });
        return;
      }
      setPhase((p) => (p.kind === "waiting" && p.jobId === waitingJob ? { ...p, running: job.position === "running" } : p));
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    timer = setTimeout(() => void tick(), 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [waitingJob]);

  function submit(request: { instruction: string; attachmentKeys: string[]; reference: Reference | null }, again: boolean) {
    if (!signedIn) {
      onSignIn();
      return;
    }
    setNotice(null);
    startTransition(async () => {
      const result = await requestDesignRoundAction({ designId, spec, ...request, again });
      if (result.status === "signin") {
        onSignIn();
        return;
      }
      if (result.status === "error") {
        setPhase({ kind: "error", message: result.message });
        return;
      }
      setQuota(result.quota);
      setLastRequest(request);
      if (result.designId !== designId) {
        loadedFor.current = result.designId;
        onDesignId(result.designId);
      }
      if (result.cached) {
        setNotice("Same request as before, so here are those results again (this didn't use a round). Press Generate again for new ideas.");
      }
      setReference(null);
      setPhase({ kind: "waiting", jobId: result.jobId, running: false });
    });
  }

  function generate() {
    const text = instruction.trim();
    // "Like option 2 …" refers to the options on screen when no option was chosen to refine.
    const mentioned = Number(/\boption\s*([1-4])\b/i.exec(text)?.[1] ?? 0) - 1;
    const implied = round && mentioned >= 0 && mentioned < round.options.length ? { roundId: round.id, optionIndex: mentioned } : null;
    submit({ instruction: text, attachmentKeys: attachments.map((a) => a.key), reference: reference ?? implied }, false);
  }

  async function attach(files: FileList) {
    if (!signedIn) {
      onSignIn();
      return;
    }
    setAttaching(true);
    setPhase((p) => (p.kind === "error" ? { kind: "idle" } : p));
    try {
      for (const file of Array.from(files).slice(0, MAX_PHOTOS - attachments.length)) {
        const blob = await downscalePhoto(file);
        const form = new FormData();
        form.set("photo", blob, "photo.jpg");
        const result = await uploadAiAttachmentAction(form);
        if (result.status === "signin") {
          onSignIn();
          return;
        }
        if (result.status === "error") {
          setPhase({ kind: "error", message: result.message });
          return;
        }
        setAttachments((a) => [...a, { key: result.key, url: result.url }].slice(0, MAX_PHOTOS));
      }
    } catch (error) {
      setPhase({ kind: "error", message: error instanceof Error ? error.message : "That photo couldn't be attached." });
    } finally {
      setAttaching(false);
    }
  }

  function pick(target: RoundView, index: number) {
    startTransition(async () => {
      const result = await pickOptionAction(target.id, index);
      if (result.status === "signin") {
        onSignIn();
        return;
      }
      if (result.status === "error") {
        setPhase({ kind: "error", message: result.message });
        return;
      }
      const chosen = { ...target, chosenIndex: index };
      setRound((r) => (r?.id === target.id ? chosen : r));
      setHistory((h) => h.map((r) => (r.id === target.id ? chosen : r)));
      onPick(result.spec, result.imageUrls, `option ${index + 1}`);
    });
  }

  const busy = pending || phase.kind === "waiting";
  const canGenerate = !busy && !attaching && instruction.trim().length >= 3 && quota?.remaining !== 0;

  return (
    <section className="flex flex-col gap-3 rounded-xl border p-4" data-testid="ai-box" aria-labelledby="ai-box-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="ai-box-title" className="font-medium">
          AI design box
        </h2>
        {quota && (
          <span className="text-xs text-muted-foreground" data-testid="ai-quota">
            {quota.remaining} of {quota.limit} AI rounds left today
          </span>
        )}
      </div>
      <p className="text-sm text-muted-foreground">Describe what you&apos;d like and get four ideas you can pick from and keep editing.</p>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="sr-only">Describe your idea</span>
        <textarea
          aria-label="Describe your idea"
          value={instruction}
          maxLength={500}
          rows={3}
          placeholder="e.g. Pastel florals on the skirt"
          onChange={(e) => setInstruction(e.target.value)}
          className="rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      </label>
      <div className="flex flex-wrap gap-1.5" aria-label="Example ideas">
        {EXAMPLES.map((example) => (
          <button key={example} type="button" onClick={() => setInstruction(example)} className="rounded-full border px-2.5 py-1 text-xs hover:bg-muted">
            {example}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {attachments.map((a, i) => (
          <span key={a.key} className="relative size-14 overflow-hidden rounded-lg border bg-muted">
            {a.url && <Image src={a.url} alt={`Attached photo ${i + 1}`} fill unoptimized className="object-cover" />}
            <button
              type="button"
              aria-label={`Remove photo ${i + 1}`}
              onClick={() => setAttachments((list) => list.filter((x) => x.key !== a.key))}
              className="absolute top-0.5 right-0.5 flex size-5 items-center justify-center rounded-full bg-background/90 text-xs"
            >
              ×
            </button>
          </span>
        ))}
        {attachments.length < MAX_PHOTOS && (
          <label className={cn("inline-flex h-8 cursor-pointer items-center rounded-lg border px-3 text-sm hover:bg-muted", (attaching || busy) && "pointer-events-none opacity-60")}>
            {attaching ? "Attaching…" : "Attach photos"}
            <input
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              aria-label="Attach photos"
              onChange={(e) => {
                const files = e.currentTarget.files;
                if (files && files.length > 0) void attach(files);
                e.currentTarget.value = "";
              }}
            />
          </label>
        )}
        <span className="text-xs text-muted-foreground">Up to 3 photos, 10 MB each.</span>
      </div>
      <p className="text-xs text-muted-foreground">Clothing brand logos can&apos;t be used.</p>

      {reference && round && (
        <p className="flex items-center gap-2 text-sm" data-testid="ai-reference">
          Refers to option {reference.optionIndex + 1}
          <button type="button" className="text-xs underline" onClick={() => setReference(null)}>
            Clear
          </button>
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button onClick={generate} disabled={!canGenerate}>
          {phase.kind === "waiting" ? "Designing…" : "Generate 4 ideas"}
        </Button>
        {lastRequest && round && (
          <Button variant="outline" onClick={() => submit(lastRequest, true)} disabled={busy || quota?.remaining === 0}>
            Generate again
          </Button>
        )}
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
        <div className="flex flex-col gap-2" data-testid="ai-loading" aria-live="polite">
          <p className="text-sm text-muted-foreground">
            {phase.running ? "Designing your four ideas…" : "Waiting for the design helper…"}
          </p>
          <div className="grid grid-cols-2 gap-3">
            {[1, 2, 3, 4].map((n) => (
              <div key={n} className="flex aspect-[600/780] animate-pulse items-center justify-center rounded-lg bg-muted text-xs text-muted-foreground" data-testid="ai-loading-card">
                Option {n}
              </div>
            ))}
          </div>
        </div>
      )}

      {round && phase.kind !== "waiting" && (
        <div className="flex flex-col gap-2" data-testid="ai-results">
          <p className="text-sm">
            Ideas for <span className="italic">“{round.instruction}”</span>
          </p>
          <div className="grid grid-cols-2 gap-3">
            {round.options.map((option) => (
              <OptionCard
                key={option.index}
                option={option}
                chosen={round.chosenIndex === option.index}
                referenced={reference?.roundId === round.id && reference.optionIndex === option.index}
                disabled={pending}
                onPick={() => pick(round, option.index)}
                onRefine={() => setReference({ roundId: round.id, optionIndex: option.index })}
              />
            ))}
          </div>
        </div>
      )}

      {history.length > 0 && (
        <details className="text-sm" data-testid="ai-history">
          <summary className="cursor-pointer text-muted-foreground">Previous rounds ({history.length})</summary>
          <ul className="mt-2 flex flex-col gap-2">
            {history.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => {
                    setRound(r);
                    setReference(null);
                  }}
                  className={cn("flex w-full items-center gap-2 rounded-lg border p-2 text-left hover:bg-muted", round?.id === r.id && "border-foreground")}
                >
                  <span className="flex gap-1">
                    {r.options.slice(0, 4).map((o) =>
                      o.previewUrl ? (
                        <Image key={o.index} src={o.previewUrl} alt="" width={30} height={39} unoptimized className={cn("rounded bg-muted", r.chosenIndex === o.index && "ring-2 ring-foreground")} />
                      ) : null,
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{r.instruction}</span>
                  {r.chosenIndex !== null && <span className="text-xs text-muted-foreground">Picked {r.chosenIndex + 1}</span>}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function OptionCard({
  option,
  chosen,
  referenced,
  disabled,
  onPick,
  onRefine,
}: {
  option: RoundView["options"][number];
  chosen: boolean;
  referenced: boolean;
  disabled: boolean;
  onPick: () => void;
  onRefine: () => void;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5 rounded-lg border p-2", (chosen || referenced) && "border-foreground")} data-testid="ai-option">
      <div className="relative aspect-[600/780] overflow-hidden rounded bg-muted">
        {option.previewUrl && <Image src={option.previewUrl} alt={`Option ${option.index + 1}: ${option.title}`} fill unoptimized className="object-contain" />}
        <span className="absolute top-1 left-1 rounded bg-background/90 px-1.5 text-xs font-medium">{option.index + 1}</span>
      </div>
      <p className="truncate text-sm font-medium" title={option.title}>
        {option.title}
      </p>
      {option.summary && <p className="line-clamp-2 text-xs text-muted-foreground">{option.summary}</p>}
      <div className="flex gap-1.5">
        <Button size="sm" onClick={onPick} disabled={disabled} aria-label={`Pick option ${option.index + 1}`}>
          {chosen ? "Picked" : "Pick"}
        </Button>
        <Button size="sm" variant="outline" onClick={onRefine} aria-label={`Refine option ${option.index + 1}`}>
          Refine
        </Button>
      </div>
    </div>
  );
}
