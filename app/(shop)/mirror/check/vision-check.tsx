"use client";

import { useEffect, useRef, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import type { VisionClient } from "@/lib/vision/runtime/client";
import type { VisionBackend, VisionResult } from "@/lib/vision/runtime/engine";
import { KEYPOINT_NAMES } from "@/lib/vision/models/movenet";
import { SELFIE_SIZE } from "@/lib/vision/models/segment";
import { PoseSmoother } from "@/lib/vision/mirror/smooth";

// Runs the on-device models on the camera or a chosen photo and shows what they find and how fast.
// The face model is the slowest, so on video it runs on every 10th frame only; the person outline moves
// little between frames, so it runs on every 2nd.

const FACE_EVERY = 10;
const MASK_EVERY = 2;

type Stats = { fps: number; ms: VisionResult["ms"]; faces: number; people: string };
type Status = { kind: "idle" } | { kind: "loading" } | { kind: "ready"; backend: VisionBackend; loadMs: number } | { kind: "error"; message: string };

/** Milliseconds since the page loaded (outside the component, so React treats renders as pure). */
const clock = () => performance.now();

const BACKEND_LABEL: Record<VisionBackend, string> = { webgpu: "Graphics card (WebGPU)", wasm: "Processor (WebAssembly)" };

export function VisionCheck() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const clientRef = useRef<VisionClient | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const runningRef = useRef(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [stats, setStats] = useState<Stats | null>(null);
  const [cameraOn, setCameraOn] = useState(false);

  useEffect(
    () => () => {
      runningRef.current = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      clientRef.current?.dispose();
    },
    [],
  );

  async function client(): Promise<VisionClient> {
    if (clientRef.current) return clientRef.current;
    setStatus({ kind: "loading" });
    const started = clock();
    const { VisionClient } = await import("@/lib/vision/runtime/client");
    const created = new VisionClient(["pose", "face", "mask"]);
    clientRef.current = created;
    try {
      const backend = await created.ready;
      setStatus({ kind: "ready", backend, loadMs: Math.round(clock() - started) });
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : "The models couldn't start." });
      clientRef.current = null;
      created.dispose();
      throw error;
    }
    return created;
  }

  async function startCamera() {
    if (!window.isSecureContext || !navigator.mediaDevices) {
      setStatus({ kind: "error", message: "The camera only works on a secure (https) page or on localhost." });
      return;
    }
    const vision = await client().catch(() => null);
    if (!vision) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch {
      setStatus({ kind: "error", message: "The camera couldn't be opened. Check that this site may use it." });
      return;
    }
    streamRef.current = stream;
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    await video.play();
    setCameraOn(true);
    runningRef.current = true;
    const smoother = new PoseSmoother(KEYPOINT_NAMES);
    let frames = 0;
    let windowStart = clock();
    let faces: VisionResult["faces"] = null;
    let mask: VisionResult["mask"] = null;
    let tick = 0;
    while (runningRef.current) {
      if (video.readyState < 2) {
        await new Promise((r) => requestAnimationFrame(r));
        continue;
      }
      const bitmap = await createImageBitmap(video);
      const result = await vision.analyse(bitmap, { pose: true, mask: tick % MASK_EVERY === 0, face: tick % FACE_EVERY === 0 }).catch(() => null);
      if (!result) break;
      if (result.faces) faces = result.faces;
      if (result.mask) mask = result.mask;
      const now = clock();
      const pose = result.pose ? smoother.next(result.pose, now) : null;
      draw(video, { ...result, pose, faces, mask }, true);
      frames += 1;
      tick += 1;
      if (now - windowStart > 1000) {
        setStats({ fps: Math.round((frames * 1000) / (now - windowStart)), ms: result.ms, faces: faces?.length ?? 0, people: describe(result) });
        frames = 0;
        windowStart = now;
      }
    }
  }

  function stopCamera() {
    runningRef.current = false;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
  }

  async function analysePhoto(file: File) {
    stopCamera();
    const vision = await client().catch(() => null);
    if (!vision) return;
    const bitmap = await createImageBitmap(file);
    const shown = await createImageBitmap(bitmap);
    const result = await vision.analyse(bitmap, { pose: true, face: true, mask: true });
    draw(shown, result, false);
    shown.close();
    setStats({ fps: 0, ms: result.ms, faces: result.faces?.length ?? 0, people: describe(result) });
  }

  function draw(source: CanvasImageSource, result: VisionResult, mirrored: boolean) {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const { width, height } = result;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    context.save();
    if (mirrored) {
      context.translate(width, 0);
      context.scale(-1, 1);
    }
    context.drawImage(source, 0, 0, width, height);
    if (result.mask) {
      const tint = new ImageData(SELFIE_SIZE, SELFIE_SIZE);
      result.mask.alpha.forEach((a, i) => tint.data.set([0, 190, 255, Math.round(a * 110)], i * 4));
      const square = new OffscreenCanvas(SELFIE_SIZE, SELFIE_SIZE);
      square.getContext("2d")?.putImageData(tint, 0, 0);
      const { scale, offsetX, offsetY } = result.mask.box;
      context.drawImage(square, -offsetX / scale, -offsetY / scale, SELFIE_SIZE / scale, SELFIE_SIZE / scale);
    }
    const dot = Math.max(3, width / 120);
    if (result.pose) {
      for (const [name, point] of Object.entries(result.pose)) {
        if (point.score < 0.3) continue;
        context.fillStyle = name.startsWith("left") ? "#22c55e" : name.startsWith("right") ? "#ef4444" : "#facc15";
        context.beginPath();
        context.arc(point.x, point.y, dot, 0, Math.PI * 2);
        context.fill();
      }
    }
    context.strokeStyle = "#d946ef";
    context.lineWidth = Math.max(2, width / 300);
    for (const face of result.faces ?? []) context.strokeRect(face.x, face.y, face.width, face.height);
    context.restore();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {cameraOn ? (
          <Button variant="outline" onClick={stopCamera}>
            Stop camera
          </Button>
        ) : (
          <Button onClick={() => void startCamera()} disabled={status.kind === "loading"}>
            Use my camera
          </Button>
        )}
        <label className={buttonVariants({ variant: "outline", className: "cursor-pointer" })}>
          Try a photo
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (file) void analysePhoto(file);
            }}
          />
        </label>
        <span className="text-sm text-muted-foreground" data-testid="vision-status">
          {status.kind === "loading" && "Loading the models (about 7–14 MB the first time)…"}
          {status.kind === "ready" && `Running on: ${BACKEND_LABEL[status.backend]} · ready in ${(status.loadMs / 1000).toFixed(1)} s`}
          {status.kind === "error" && status.message}
        </span>
      </div>
      {stats && (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm tabular-nums sm:grid-cols-4" data-testid="vision-stats">
          {stats.fps > 0 && (
            <div>
              <dt className="text-muted-foreground">Frames per second</dt>
              <dd className="font-medium">{stats.fps}</dd>
            </div>
          )}
          <div>
            <dt className="text-muted-foreground">Body / outline / face</dt>
            <dd className="font-medium">
              {stats.ms.pose ?? "–"} / {stats.ms.mask ?? "–"} / {stats.ms.face ?? "–"} ms
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Faces</dt>
            <dd className="font-medium">{stats.faces}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Body</dt>
            <dd className="font-medium">{stats.people}</dd>
          </div>
        </dl>
      )}
      <video ref={videoRef} className="hidden" playsInline muted />
      <canvas ref={canvasRef} className="w-full max-w-2xl rounded-2xl border bg-muted" />
    </div>
  );
}

function describe(result: VisionResult): string {
  const pose = result.pose;
  if (!pose) return "–";
  const seen = (names: (keyof typeof pose)[]) => names.every((n) => pose[n].score >= 0.3);
  if (seen(["leftShoulder", "rightShoulder", "leftKnee", "rightKnee"])) return "Shoulders to knees";
  if (seen(["leftShoulder", "rightShoulder", "leftHip", "rightHip"])) return "Shoulders to hips";
  if (seen(["leftShoulder", "rightShoulder"])) return "Shoulders only";
  return "Not found";
}
