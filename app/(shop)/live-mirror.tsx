"use client";

import { Camera, X } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import type { VisionClient } from "@/lib/vision/client";
import type { PersonLayer } from "@/lib/vision/draw";
import type { MirrorGarment } from "@/lib/vision/garment-source";
import type { Pose } from "@/lib/vision/movenet";

// Live mirror: the camera, shown like a mirror, with the garment drawn on the customer as they move.
// Everything runs on this device: the body and outline models run in a worker in this tab, the garment
// picture is prepared here, and nothing is recorded or uploaded. A captured photo stays on the device
// unless the customer chooses to use it for the realistic (AI) try-on.

/** The person outline runs on every 2nd frame; the body on every frame. */
const MASK_EVERY = 2;

type Phase = { kind: "intro" } | { kind: "starting" } | { kind: "running" } | { kind: "error"; message: string };
type Capture = { mirroredUrl: string; plain: Blob; width: number; height: number };

const clock = () => performance.now();

export function LiveMirror({
  loadGarment,
  noun,
  onClose,
  onUsePhoto,
}: {
  /** Prepares the garment picture (cut out and measured); called when the camera starts. */
  loadGarment: () => Promise<MirrorGarment>;
  noun: string;
  onClose: () => void;
  /** Hands the plain camera frame (without the garment) to the realistic try-on. */
  onUsePhoto?: (photo: Blob) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const visionRef = useRef<VisionClient | null>(null);
  const runningRef = useRef(false);
  /** Where the person is (camera pixels), to crop a portrait photo around them. */
  const centreRef = useRef<number | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "intro" });
  const [hint, setHint] = useState<string | null>(null);
  const [capture, setCapture] = useState<Capture | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      runningRef.current = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      visionRef.current?.dispose();
    };
  }, [onClose]);

  useEffect(() => () => {
    if (capture) URL.revokeObjectURL(capture.mirroredUrl);
  }, [capture]);

  async function start() {
    if (!window.isSecureContext || !navigator.mediaDevices) {
      setPhase({ kind: "error", message: "The live mirror needs a secure (https) page to use the camera." });
      return;
    }
    setPhase({ kind: "starting" });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch {
      setPhase({ kind: "error", message: "The camera couldn't be opened. Check that this site may use it, then try again." });
      return;
    }
    streamRef.current = stream;
    const [{ VisionClient }, { PersonLayer: Layer }, mirror] = await Promise.all([import("@/lib/vision/client"), import("@/lib/vision/draw"), import("@/lib/vision/mirror")]);
    const vision = new VisionClient(["pose", "mask"]);
    visionRef.current = vision;
    let garment: MirrorGarment;
    try {
      [garment] = await Promise.all([loadGarment(), vision.ready]);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      setPhase({ kind: "error", message: `The live mirror couldn't start for this ${noun} on this device.` });
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    await video.play();
    setPhase({ kind: "running" });
    runningRef.current = true;
    void loop(video, vision, garment, new Layer(), mirror);
  }

  async function loop(video: HTMLVideoElement, vision: VisionClient, garment: MirrorGarment, layer: PersonLayer, mirror: typeof import("@/lib/vision/mirror")) {
    const { PoseSmoother } = await import("@/lib/vision/smooth");
    const { KEYPOINT_NAMES } = await import("@/lib/vision/movenet");
    const { GarmentCompositor } = await import("@/lib/vision/draw");
    const smoother = new PoseSmoother(KEYPOINT_NAMES);
    const compositor = new GarmentCompositor();
    let tick = 0;
    let lastHint: string | null = "";
    while (runningRef.current) {
      if (video.readyState < 2) {
        await new Promise((r) => requestAnimationFrame(r));
        continue;
      }
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      if (!canvas || !context) break;
      const width = video.videoWidth;
      const height = video.videoHeight;
      const bitmap = await createImageBitmap(video);
      const frame = await createImageBitmap(bitmap);
      const result = await vision.analyse(bitmap, { pose: true, mask: tick % MASK_EVERY === 0 }).catch(() => null);
      tick += 1;
      if (!result) {
        frame.close();
        break;
      }
      if (result.mask) layer.setMask(result.mask);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.drawImage(frame, 0, 0, width, height);
      const pose: Pose | null = result.pose ? smoother.next(result.pose, clock()) : null;
      const body = pose ? mirror.bodyAnchors(pose) : null;
      centreRef.current = body ? (body.leftShoulder.x + body.rightShoulder.x + body.leftHip.x + body.rightHip.x) / 4 : null;
      if (pose && body) {
        // The body, then each sleeve bent along its arm; then the arms the garment doesn't cover, in front.
        const pieces = [
          { image: garment.body, triangles: mirror.garmentMesh(garment.fit, body) },
          ...garment.sleeves.map((s) => ({ image: s.image, triangles: mirror.sleeveMesh(garment.fit, s.fit, body) })),
        ];
        compositor.draw(context, frame, width, height, pieces);
        const sleeveOn = (side: "left" | "right") => garment.sleeves.find((s) => s.fit.side === side)?.fit ?? null;
        const arms = (["left", "right"] as const).map((side) => mirror.exposedArm(garment.fit, body, side, sleeveOn(side)));
        const span = Math.hypot(body.leftShoulder.x - body.rightShoulder.x, body.leftShoulder.y - body.rightShoulder.y);
        layer.drawArms(context, frame, width, height, arms, span * 0.3);
      }
      frame.close();
      const nextHint = body ? null : pose && pose.leftShoulder.score > 0.3 && pose.leftShoulder.x <= pose.rightShoulder.x ? "Turn to face the camera." : "Step back until your shoulders and hips are in view.";
      if (nextHint !== lastHint) {
        lastHint = nextHint;
        setHint(nextHint);
      }
    }
  }

  async function takePhoto() {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    // As seen in the mirror (flipped), and the plain camera frame for the realistic try-on.
    const flipped = document.createElement("canvas");
    flipped.width = canvas.width;
    flipped.height = canvas.height;
    const fc = flipped.getContext("2d");
    // Try-on photos are portrait: a 3:4 crop of the camera frame around the person.
    const plainCanvas = document.createElement("canvas");
    plainCanvas.height = video.videoHeight;
    plainCanvas.width = Math.min(video.videoWidth, Math.round((video.videoHeight * 3) / 4));
    const pc = plainCanvas.getContext("2d");
    if (!fc || !pc) return;
    fc.translate(flipped.width, 0);
    fc.scale(-1, 1);
    fc.drawImage(canvas, 0, 0);
    const centre = centreRef.current ?? video.videoWidth / 2;
    const left = Math.min(Math.max(0, Math.round(centre - plainCanvas.width / 2)), video.videoWidth - plainCanvas.width);
    pc.drawImage(video, left, 0, plainCanvas.width, plainCanvas.height, 0, 0, plainCanvas.width, plainCanvas.height);
    const toBlob = (c: HTMLCanvasElement) => new Promise<Blob | null>((resolve) => c.toBlob(resolve, "image/jpeg", 0.9));
    const [mirrored, plain] = await Promise.all([toBlob(flipped), toBlob(plainCanvas)]);
    if (!mirrored || !plain) return;
    setCapture({ mirroredUrl: URL.createObjectURL(mirrored), plain, width: flipped.width, height: flipped.height });
  }

  // Rendered at the top of the page, above any sticky panels of the screen that opened it.
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-black text-white" role="dialog" aria-modal="true" aria-label="Live mirror" data-testid="live-mirror">
      <div className="flex items-center justify-between gap-3 px-4 pt-[calc(env(safe-area-inset-top,0px)+12px)] pb-3">
        <p className="text-sm text-white/80">Live mirror · your camera stays on this device; nothing is recorded or uploaded.</p>
        <Button variant="secondary" size="icon" aria-label="Close the live mirror" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        <video ref={videoRef} className="hidden" playsInline muted />
        <canvas ref={canvasRef} className={phase.kind === "running" ? "max-h-full max-w-full -scale-x-100" : "hidden"} data-testid="live-mirror-canvas" />
        {phase.kind === "intro" && (
          <div className="flex max-w-md flex-col items-center gap-4 px-6 text-center">
            <Camera className="size-10 text-white/70" />
            <h2 className="text-xl font-semibold">See this {noun} on you, live</h2>
            <p className="text-sm text-white/80">
              Stand 1–3 m from the camera so you&apos;re visible from your shoulders to your knees, facing it. The {noun} follows you as you move. It&apos;s a
              quick fit guide; for a realistic photo, use Try on.
            </p>
            <Button onClick={() => void start()}>Start camera</Button>
          </div>
        )}
        {phase.kind === "starting" && <p className="text-sm text-white/80">Starting the camera and the on-device models (about 13 MB the first time)…</p>}
        {phase.kind === "error" && (
          <p className="max-w-md px-6 text-center text-sm" role="alert">
            {phase.message}
          </p>
        )}
        {phase.kind === "running" && hint && (
          <p className="absolute top-4 left-1/2 -translate-x-1/2 rounded-full bg-black/70 px-4 py-2 text-sm" data-testid="live-mirror-hint">
            {hint}
          </p>
        )}
      </div>

      {phase.kind === "running" && (
        <div className="flex flex-wrap items-center justify-center gap-3 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom,0px)+16px)]">
          <Button onClick={() => void takePhoto()}>Take photo</Button>
        </div>
      )}

      {capture && (
        <div className="absolute inset-x-4 bottom-24 mx-auto flex max-w-md flex-col gap-3 rounded-xl bg-white p-4 text-foreground shadow-lg" data-testid="live-mirror-capture">
          <Image
            src={capture.mirroredUrl}
            alt={`You in this ${noun} (live mirror)`}
            width={capture.width}
            height={capture.height}
            unoptimized
            className="h-auto max-h-60 w-auto self-center rounded-lg object-contain"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => {
                const link = document.createElement("a");
                link.href = capture.mirroredUrl;
                link.download = "clothseeker-mirror.jpg";
                link.click();
              }}
            >
              Save picture
            </Button>
            {onUsePhoto && (
              <Button
                variant="outline"
                onClick={() => {
                  onUsePhoto(capture.plain);
                  onClose();
                }}
              >
                Use for the realistic try-on
              </Button>
            )}
            <Button variant="ghost" onClick={() => setCapture(null)}>
              Back to the mirror
            </Button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
