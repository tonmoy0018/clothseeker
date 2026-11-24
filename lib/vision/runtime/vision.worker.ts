import { VisionEngine } from "./engine";
import { isToWorker, type FromWorker } from "./protocol";

// The vision models' own thread, so the page and the camera preview stay smooth while they run.
// Frames arrive as transferred ImageBitmaps; person masks go back as transferred buffers.

let engine: Promise<VisionEngine> | null = null;

function reply(message: FromWorker, transfer: Transferable[] = []) {
  postMessage(message, { transfer });
}

addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = event.data;
  if (!isToWorker(message)) return;
  if (message.type === "init") {
    engine ??= VisionEngine.create(message.models);
    engine.then(
      (ready) => reply({ type: "ready", backend: ready.backend }),
      (error: unknown) => reply({ type: "failed", message: error instanceof Error ? error.message : "The vision models couldn't start" }),
    );
    return;
  }
  const { id, frame, request } = message;
  if (!engine) {
    frame.close();
    reply({ type: "error", id, message: "not started" });
    return;
  }
  engine
    .then((ready) => ready.analyse(frame, frame.width, frame.height, request))
    .then(
      (result) => reply({ type: "result", id, result }, [...(result.mask ? [result.mask.alpha.buffer] : []), ...(result.parts ? [result.parts.classes.buffer] : [])]),
      (error: unknown) => reply({ type: "error", id, message: error instanceof Error ? error.message : "analysis failed" }),
    )
    .finally(() => frame.close());
});
