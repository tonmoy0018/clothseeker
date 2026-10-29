import type { VisionModelId } from "./assets";
import type { VisionBackend, VisionRequest, VisionResult } from "./engine";
import { isFromWorker, type ToWorker } from "./protocol";

// The page's handle on the vision worker. Everything stays on the customer's device: frames go to a
// worker in the same tab, and the models are served from our own site (lib/vision/assets.ts).

export class VisionClient {
  readonly ready: Promise<VisionBackend>;
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (result: VisionResult) => void; reject: (error: Error) => void }>();

  constructor(models: VisionModelId[]) {
    this.worker = new Worker(new URL("./vision.worker.ts", import.meta.url), { type: "module" });
    this.ready = new Promise((resolve, reject) => {
      this.worker.addEventListener("message", (event: MessageEvent<unknown>) => {
        const message = event.data;
        if (!isFromWorker(message)) return;
        if (message.type === "ready") resolve(message.backend);
        else if (message.type === "failed") reject(new Error(message.message));
        else {
          const waiting = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.type === "result") waiting?.resolve(message.result);
          else waiting?.reject(new Error(message.message));
        }
      });
      this.worker.addEventListener("error", () => reject(new Error("The vision worker couldn't start")));
    });
    this.post({ type: "init", models });
  }

  /** Analyses one frame; the bitmap is handed over to the worker (and closed there). */
  analyse(frame: ImageBitmap, request: VisionRequest): Promise<VisionResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post({ type: "analyse", id, frame, request }, [frame]);
    });
  }

  dispose(): void {
    this.worker.terminate();
    for (const waiting of this.pending.values()) waiting.reject(new Error("stopped"));
    this.pending.clear();
  }

  private post(message: ToWorker, transfer: Transferable[] = []) {
    this.worker.postMessage(message, transfer);
  }
}
