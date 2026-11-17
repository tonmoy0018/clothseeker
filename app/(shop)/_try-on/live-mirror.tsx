"use client";

import { Camera, Sparkles, X } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { downscalePhoto } from "@/lib/media/client-resize";
import { TRYON_CONSENT_POINTS } from "@/lib/tryon/rules";
import type { VisionClient } from "@/lib/vision/runtime/client";
import type { VisionResult } from "@/lib/vision/runtime/engine";
import type { PersonLayer } from "@/lib/vision/mirror/draw";
import type { BodyAnchors } from "@/lib/vision/mirror/mirror";
import type { MirrorGarment, PartsReader } from "@/lib/vision/mirror/garment-source";
import type { Pose } from "@/lib/vision/models/movenet";
import type { BodyParts } from "@/lib/vision/models/parts";
import type { PersonMask } from "@/lib/vision/models/segment";

import { getTryOnStatusAction, startTryOnAction, uploadTryOnPhotoAction } from "./actions";
import type { TryOnSource } from "./try-on-panel";

// Live mirror: the camera, shown like a mirror, with the garment drawn on the customer as they move.
// Everything runs on this device: the body and outline models run in a worker in this tab, the garment
// picture is prepared here, and nothing is recorded or uploaded. A captured photo stays on the device
// unless the customer chooses to use it for the realistic (AI) try-on.

/** The person outline runs on every 2nd frame; the body on every frame. */
const MASK_EVERY = 2;
/** The body-parts model (hair in front of the garment) runs on every PARTS_EVERY-th frame: it's the slowest. */
const PARTS_EVERY = 6;

type Phase = { kind: "intro" } | { kind: "starting" } | { kind: "running" } | { kind: "error"; message: string };
type Capture = { mirroredUrl: string; plain: Blob; width: number; height: number };
/** "Make it real": the realistic AI try-on of the current pose, shown in the mirror. */
type Real =
  | { kind: "off" }
  | { kind: "consent" }
  | { kind: "working"; step: string }
  | { kind: "done"; imageUrl: string; left: number | null }
  | { kind: "error"; message: string };

const POLL_MS = 2000;
const POLL_GIVE_UP_MS = 12 * 60 * 1000;

const clock = () => performance.now();

export function LiveMirror({
  loadGarment,
  noun,
  onClose,
  onUsePhoto,
  realistic,
}: {
  /**
   * Prepares the garment picture (cut out and measured); called when the camera starts, with a reader for
   * the body-parts model (it fills what the colour-based cut-out misses of a pale garment).
   */
  loadGarment: (readParts: PartsReader) => Promise<MirrorGarment>;
  noun: string;
  onClose: () => void;
  /** Hands the plain camera frame (without the garment) to the realistic try-on. */
  onUsePhoto?: (photo: Blob) => void;
  /** Enables "Make it real": what to try on, and the customer's sign-in state. */
  realistic?: { source: TryOnSource; signedIn: boolean; onSignIn: () => void };
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
  const [real, setReal] = useState<Real>({ kind: "off" });
  const [agreed, setAgreed] = useState(false);

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
    const [{ VisionClient }, { PersonLayer: Layer }, mirror] = await Promise.all([import("@/lib/vision/runtime/client"), import("@/lib/vision/mirror/draw"), import("@/lib/vision/mirror/mirror")]);
    const vision = new VisionClient(["body", "mask", "matte", "parts"]);
    visionRef.current = vision;
    const readParts: PartsReader = async (picture: HTMLCanvasElement) => {
      const bitmap = await createImageBitmap(picture);
      return (await vision.analyse(bitmap, { parts: { left: 0, top: 0, width: picture.width, height: picture.height } })).parts;
    };
    let garment: MirrorGarment;
    try {
      await vision.ready;
      garment = await loadGarment(readParts);
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

  async function loop(video: HTMLVideoElement, vision: VisionClient, garment: MirrorGarment, layer: PersonLayer, mirror: typeof import("@/lib/vision/mirror/mirror")) {
    const { PoseSmoother } = await import("@/lib/vision/mirror/smooth");
    const { KEYPOINT_NAMES } = await import("@/lib/vision/models/movenet");
    const { GarmentCompositor, FrameCleaner } = await import("@/lib/vision/mirror/draw");
    const { ClothSway, WidthSmoother } = await import("@/lib/vision/mirror/cloth");
    const { maskAtSmooth } = await import("@/lib/vision/models/segment");
    const smoother = new PoseSmoother(KEYPOINT_NAMES);
    const compositor = new GarmentCompositor();
    const cleaner = new FrameCleaner();
    const sway = new ClothSway();
    const widthSmoother = new WidthSmoother();
    let mask: PersonMask | null = null;
    /** Where the body was (unsmoothed) when hair was last read, and the latest body. */
    let partsCentre: { x: number; y: number } | null = null;
    let lastCentre: { x: number; y: number } | null = null;
    let lastBody: BodyAnchors | null = null;
    /** Where the body was in the frame the person mask was made from. */
    let maskCentre: { x: number; y: number } | null = null;
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
      // Hair is read around where the person was last seen (the region needs the pose from before).
      const partsAt: BodyParts["region"] | undefined = tick % PARTS_EVERY === 1 && lastBody ? mirror.partsRegion(lastBody, bitmap.width, bitmap.height) : undefined;
      const result: VisionResult | null = await vision.analyse(bitmap, { pose: true, mask: tick % MASK_EVERY === 0, parts: partsAt }).catch(() => null);
      tick += 1;
      if (!result) {
        frame.close();
        break;
      }
      if (result.mask) {
        layer.setMask(result.mask);
        mask = result.mask;
        maskCentre = null;
      }
      if (partsAt) {
        layer.setParts(result.parts);
        partsCentre = lastCentre;
      }
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.drawImage(frame, 0, 0, width, height);
      const pose: Pose | null = result.pose ? smoother.next(result.pose, clock()) : null;
      const body: BodyAnchors | null = pose ? mirror.bodyAnchors(pose) : null;
      centreRef.current = body ? (body.leftShoulder.x + body.rightShoulder.x + body.leftHip.x + body.rightHip.x) / 4 : null;
      if (pose && body) {
        const span = Math.hypot(body.leftShoulder.x - body.rightShoulder.x, body.leftShoulder.y - body.rightShoulder.y);
        // Measured on the unsmoothed pose: the mask is exactly where the person was in its own frame.
        const raw = result.pose ?? pose;
        const centre = { x: (raw.leftShoulder.x + raw.rightShoulder.x + raw.leftHip.x + raw.rightHip.x) / 4, y: (raw.leftShoulder.y + raw.rightShoulder.y + raw.leftHip.y + raw.rightHip.y) / 4 };
        maskCentre ??= centre;
        lastCentre = centre;
        lastBody = body;
        // The outline model runs on every other frame: in between, its mask is moved along with the body.
        const seenMask = mask;
        const shift = { x: centre.x - maskCentre.x, y: centre.y - maskCentre.y };
        const person = seenMask ? (x: number, y: number) => maskAtSmooth(seenMask, x - shift.x, y - shift.y) : null;
        // Fitted to the person's outline (when the outline model has run), the hem swinging behind the hips.
        const outline = person ? mirror.measureOutline(garment.fit, body, person) : null;
        const drape = {
          widths: outline ? widthSmoother.next(mirror.fitToOutline(garment.fit, body, outline)) : null,
          sway: sway.next({ x: (body.leftHip.x + body.rightHip.x) / 2, y: (body.leftHip.y + body.rightHip.y) / 2 }, span, clock()),
        };
        // Their own clothes where the garment won't cover them become skin or backdrop.
        const clean = cleaner.run(frame, width, height, body, person);
        if (clean !== frame) context.drawImage(clean, 0, 0, width, height);
        // The body, then each sleeve bent along its arm; then the arms the garment doesn't cover, in front.
        const pieces = [
          { image: garment.body, triangles: mirror.garmentMesh(garment.fit, body, undefined, undefined, drape) },
          ...garment.sleeves.map((s) => ({ image: s.image, triangles: mirror.sleeveMesh(garment.fit, s.fit, body, undefined, undefined, drape) })),
        ];
        compositor.draw(context, frame, width, height, pieces, span);
        const sleeveOn = (side: "left" | "right") => garment.sleeves.find((s) => s.fit.side === side)?.fit ?? null;
        const arms = (["left", "right"] as const).map((side) => mirror.exposedArm(garment.fit, body, side, sleeveOn(side)));
        // About an arm's width: wider would redraw the person's own clothes beside the arm. The head too,
        // so a collar never covers the chin.
        const hairShift = partsCentre ? { x: centre.x - partsCentre.x, y: centre.y - partsCentre.y } : { x: 0, y: 0 };
        layer.drawInFront(context, clean, width, height, arms, span * mirror.ARM_WIDTH, shift, mirror.headInFront(body), hairShift);
      } else {
        sway.reset();
        widthSmoother.reset();
      }
      frame.close();
      const nextHint = body ? null : pose && pose.leftShoulder.score > 0.3 && pose.leftShoulder.x <= pose.rightShoulder.x ? "Turn to face the camera." : "Step back until your shoulders and hips are in view.";
      if (nextHint !== lastHint) {
        lastHint = nextHint;
        setHint(nextHint);
      }
    }
  }

  /** The mirror as seen (flipped, with the garment) and a plain 3:4 portrait of the person. */
  async function frames(): Promise<{ mirrored: Blob; plain: Blob; width: number; height: number } | null> {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return null;
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
    if (!fc || !pc) return null;
    fc.translate(flipped.width, 0);
    fc.scale(-1, 1);
    fc.drawImage(canvas, 0, 0);
    const centre = centreRef.current ?? video.videoWidth / 2;
    const left = Math.min(Math.max(0, Math.round(centre - plainCanvas.width / 2)), video.videoWidth - plainCanvas.width);
    pc.drawImage(video, left, 0, plainCanvas.width, plainCanvas.height, 0, 0, plainCanvas.width, plainCanvas.height);
    const toBlob = (c: HTMLCanvasElement) => new Promise<Blob | null>((resolve) => c.toBlob(resolve, "image/jpeg", 0.9));
    const [mirrored, plain] = await Promise.all([toBlob(flipped), toBlob(plainCanvas)]);
    if (!mirrored || !plain) return null;
    return { mirrored, plain, width: flipped.width, height: flipped.height };
  }

  async function takePhoto() {
    const shot = await frames();
    if (shot) setCapture({ mirroredUrl: URL.createObjectURL(shot.mirrored), plain: shot.plain, width: shot.width, height: shot.height });
  }

  /**
   * The realistic try-on of this pose: the plain frame is checked on the device, uploaded (after consent)
   * and tried on by the same AI try-on as "See it on me"; the result shows in the mirror.
   */
  async function makeItReal() {
    if (!realistic) return;
    if (!realistic.signedIn) {
      realistic.onSignIn();
      return;
    }
    if (!agreed) {
      setReal({ kind: "consent" });
      return;
    }
    setReal({ kind: "working", step: "Checking your pose on this device…" });
    const shot = await frames();
    if (!shot) {
      setReal({ kind: "error", message: "The camera picture couldn't be captured. Try again." });
      return;
    }
    const { photoProblemOnDevice } = await import("@/lib/vision/photo/check-photo");
    const problem = await photoProblemOnDevice(shot.plain);
    if (problem) {
      setReal({ kind: "error", message: problem });
      return;
    }
    setReal({ kind: "working", step: "Sending your photo…" });
    const form = new FormData();
    form.set("photo", await downscalePhoto(shot.plain), "photo.jpg");
    form.set("consent", "yes");
    const uploaded = await uploadTryOnPhotoAction(form);
    if (uploaded.status !== "ok") {
      if (uploaded.status === "signin") realistic.onSignIn();
      setReal({ kind: "error", message: uploaded.status === "error" ? uploaded.message : "Please sign in first." });
      return;
    }
    const source = realistic.source;
    const started = await startTryOnAction({
      photoId: uploaded.photo.id,
      source: source.kind === "design" ? { kind: "design", spec: source.spec, designId: source.designId } : { kind: "product", productId: source.productId },
    });
    if (started.status !== "ok") {
      setReal({ kind: "error", message: started.status === "error" ? started.message : "Please sign in first." });
      return;
    }
    const begin = clock();
    for (;;) {
      const status = await getTryOnStatusAction(started.jobId).catch(() => null);
      if (!status || status.status !== "ok") {
        setReal({ kind: "error", message: status?.status === "error" ? status.message : "We lost track of that try-on. Please try again." });
        return;
      }
      const job = status.job;
      if (job.state === "done") {
        if (!job.result.imageUrl) {
          setReal({ kind: "error", message: "The result couldn't be shown. Please try again." });
          return;
        }
        setReal({ kind: "done", imageUrl: job.result.imageUrl, left: started.quota.remaining });
        return;
      }
      if (job.state === "failed") {
        setReal({ kind: "error", message: job.message });
        return;
      }
      if (clock() - begin > POLL_GIVE_UP_MS) {
        setReal({ kind: "error", message: "The try-on service is very busy right now. Please try again later." });
        return;
      }
      setReal({ kind: "working", step: job.position === "running" ? `Putting the ${noun} on you… this can take a couple of minutes.` : "Waiting for the try-on service…" });
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
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
          {realistic && (
            <Button onClick={() => void makeItReal()} disabled={real.kind === "working"}>
              <Sparkles className="size-4" />
              Make it real
            </Button>
          )}
          <Button variant={realistic ? "secondary" : "default"} onClick={() => void takePhoto()}>
            Take photo
          </Button>
        </div>
      )}

      {real.kind !== "off" && (
        <div
          className="absolute top-16 right-4 bottom-24 flex w-[min(92vw,360px)] flex-col gap-3 overflow-y-auto rounded-2xl bg-card p-4 text-foreground shadow-lg"
          data-testid="make-it-real"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-medium">Make it real</h3>
            <Button variant="ghost" size="sm" onClick={() => setReal({ kind: "off" })} disabled={real.kind === "working"}>
              Back to live
            </Button>
          </div>
          {real.kind === "consent" && (
            <>
              <p className="text-sm">An AI makes a realistic photo of you wearing this {noun}, from your current pose.</p>
              <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                {TRYON_CONSENT_POINTS.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="size-4" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />I agree to use my photo for try-on
              </label>
              <Button disabled={!agreed} onClick={() => void makeItReal()}>
                Make it real
              </Button>
            </>
          )}
          {real.kind === "working" && (
            <p className="text-sm" role="status" data-testid="make-it-real-progress">
              {real.step} Hold your pose until it&apos;s captured; then you can move.
            </p>
          )}
          {real.kind === "error" && (
            <p className="text-sm text-destructive" role="alert">
              {real.message}
            </p>
          )}
          {real.kind === "done" && (
            <>
              <Image
                src={real.imageUrl}
                alt={`You wearing this ${noun} (AI try-on)`}
                width={384}
                height={512}
                unoptimized
                className="h-auto w-full rounded-lg object-contain"
              />
              <p className="text-xs text-muted-foreground">AI preview: the real {noun} will fit and look a little different.{real.left !== null ? ` ${real.left} left today.` : ""}</p>
              <Button onClick={() => void makeItReal()}>Make it real again</Button>
            </>
          )}
        </div>
      )}

      {capture && (
        <div className="absolute inset-x-4 bottom-24 mx-auto flex max-w-md flex-col gap-3 rounded-2xl bg-card p-4 text-foreground shadow-lg" data-testid="live-mirror-capture">
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
