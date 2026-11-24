"use client";

import { Box, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { TryOnSource } from "@/app/(shop)/_try-on/try-on-panel";
import { Button } from "@/components/ui/button";

import { getGarmentModelStatusAction, startGarmentModelAction } from "./actions";

// The 3D view: a full-screen panel that asks the worker for a 3D model of the garment (a design as it is
// in the editor, or a ready-made item), waits for it, and shows it in <model-viewer> to turn and zoom.
// The model is a quick AI guess from the front picture: the front is faithful, the back and sides guessed.

const POLL_MS = 2000;
const POLL_GIVE_UP_MS = 6 * 60 * 1000;

type Phase =
  | { kind: "signin" }
  | { kind: "starting" }
  | { kind: "waiting"; jobId: string; running: boolean }
  | { kind: "ready"; url: string }
  | { kind: "error"; message: string };

export function Garment3dView({ source, signedIn, noun, onSignIn, onClose }: { source: TryOnSource; signedIn: boolean; noun: string; onSignIn: () => void; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>(signedIn ? { kind: "starting" } : { kind: "signin" });
  const stage = useRef<HTMLDivElement>(null);
  // The source the view was opened with: later edits in the editor don't restart it.
  const [opened] = useState(source);

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    void startGarmentModelAction(opened)
      .then((response) => {
        if (cancelled) return;
        if (response.status === "queued") setPhase({ kind: "waiting", jobId: response.jobId, running: false });
        else if (response.status === "signin") setPhase({ kind: "signin" });
        else setPhase({ kind: "error", message: response.message });
      })
      .catch(() => !cancelled && setPhase({ kind: "error", message: "The 3D view couldn't be started. Please try again." }));
    return () => {
      cancelled = true;
    };
  }, [opened, signedIn]);

  const waitingJob = phase.kind === "waiting" ? phase.jobId : null;
  useEffect(() => {
    if (!waitingJob) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    const tick = async () => {
      if (cancelled) return;
      const response = await getGarmentModelStatusAction(waitingJob).catch(() => null);
      if (cancelled) return;
      if (!response || "status" in response) {
        setPhase(response?.status === "signin" ? { kind: "signin" } : { kind: "error", message: response?.status === "error" ? response.message : "We lost track of that 3D view. Please try again." });
        return;
      }
      if (response.state === "done") {
        setPhase({ kind: "ready", url: response.modelUrl });
        return;
      }
      if (response.state === "failed") {
        setPhase({ kind: "error", message: response.message });
        return;
      }
      if (Date.now() - startedAt > POLL_GIVE_UP_MS) {
        setPhase({ kind: "error", message: "The 3D view is taking too long. Please try again later." });
        return;
      }
      setPhase((p) => (p.kind === "waiting" && p.jobId === waitingJob ? { ...p, running: response.position === "running" } : p));
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    timer = setTimeout(() => void tick(), 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [waitingJob]);

  // <model-viewer> is a web component: registered on first use, made by hand (it isn't a React element).
  const readyUrl = phase.kind === "ready" ? phase.url : null;
  useEffect(() => {
    const host = stage.current;
    if (!readyUrl || !host) return;
    let viewer: HTMLElement | null = null;
    let cancelled = false;
    void import("@google/model-viewer").then(() => {
      if (cancelled) return;
      viewer = document.createElement("model-viewer");
      for (const [name, value] of Object.entries({ src: readyUrl, alt: `A 3D view of your ${noun}`, "camera-controls": "", "auto-rotate": "", "shadow-intensity": "0.8", exposure: "1.05", "interaction-prompt": "none", "data-testid": "garment-3d-model" })) {
        viewer.setAttribute(name, value);
      }
      viewer.style.width = "100%";
      viewer.style.height = "100%";
      host.replaceChildren(viewer);
    });
    return () => {
      cancelled = true;
      viewer?.remove();
    };
  }, [readyUrl, noun]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-background" role="dialog" aria-modal="true" aria-label="3D view" data-testid="garment-3d-view">
      <div className="flex items-center justify-between gap-3 px-4 pt-[calc(env(safe-area-inset-top,0px)+12px)] pb-3">
        <p className="text-sm text-muted-foreground">3D view · drag to turn, pinch or scroll to zoom. The front follows your {noun}; the back and sides are an AI guess.</p>
        <Button variant="outline" size="icon" aria-label="Close the 3D view" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        <div ref={stage} className={phase.kind === "ready" ? "size-full" : "hidden"} />
        {phase.kind !== "ready" && (
          <div className="flex max-w-md flex-col items-center gap-4 px-6 text-center">
            <Box className="size-10 text-muted-foreground" aria-hidden />
            {phase.kind === "signin" && (
              <>
                <p className="text-sm">Sign in to see this {noun} in 3D.</p>
                <Button onClick={onSignIn}>Sign in</Button>
              </>
            )}
            {(phase.kind === "starting" || phase.kind === "waiting") && (
              <p className="text-sm" role="status" data-testid="garment-3d-waiting">
                {phase.kind === "waiting" && phase.running ? `Making your ${noun} in 3D… (usually under a minute)` : "Waiting for a turn…"}
              </p>
            )}
            {phase.kind === "error" && (
              <p className="text-sm" role="alert">
                {phase.message}
              </p>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
