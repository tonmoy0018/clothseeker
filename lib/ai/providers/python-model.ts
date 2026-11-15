import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { z } from "zod";

import { AiProviderError } from "../errors";
import type { ModelSlot } from "./model-slot";

// A model in a Python process on this machine (the local try-on's CatVTON, the 3D view's TripoSR): started
// on the first job, kept loaded between jobs, stopped when idle or when a job runs out of time (a stuck
// model can't be interrupted otherwise). Jobs go to its stdin as JSON lines; it answers each on stdout
// ({"ready": true} once loaded, then {"id", "ok", "error"?}). It gets only the variables it needs, never
// the worker's keys, and its stderr is ignored: nothing it prints reaches our logs.

const replySchema = z.union([
  z.object({ ready: z.literal(true) }).loose(),
  z.object({ id: z.string().nullable(), ok: z.literal(true) }).loose(),
  z.object({ id: z.string().nullable(), ok: z.literal(false), error: z.enum(["OUT_OF_MEMORY", "INVALID_REQUEST", "FAILED"]) }),
]);

/** What the runner uses of the model's child process (a fake in tests). */
export type ModelProcess = {
  stdin: Writable;
  stdout: Readable;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "exit", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
};
export type SpawnModel = (python: string, args: string[], env: Record<string, string>) => ModelProcess;

const defaultSpawn: SpawnModel = (python, args, env) => nodeSpawn(python, args, { env: { ...env, NODE_ENV: process.env.NODE_ENV }, stdio: ["pipe", "pipe", "ignore"] });

export type PythonModelOptions = {
  /** The setup's Python (its virtual environment). */
  python: string;
  /** The model's script and its arguments (the model folder). */
  script: string;
  args: readonly string[];
  /** What errors call it ("local try-on"). */
  label: string;
  /** Variables the model needs besides PATH, HOME and staying offline (memory caps). */
  env?: Readonly<Record<string, string>>;
  /** Unload the model after this long without a job, giving the memory back. */
  idleMs?: number;
  /** Limit for loading the model. */
  loadTimeoutMs?: number;
  /** Shared with the other big local models: loading this one stops whichever holds the memory. */
  slot?: ModelSlot;
  spawn?: SpawnModel;
};

/** A job waiting for its answer, from the process it was sent to. */
type Pending = { process: ModelProcess; resolve: () => void; reject: (error: Error) => void };

export class PythonModelProcess<Job extends object> {
  private child: ModelProcess | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<string, Pending>();
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly spawnModel: SpawnModel;

  constructor(private readonly options: PythonModelOptions) {
    this.spawnModel = options.spawn ?? defaultSpawn;
  }

  run(job: Job, signal: AbortSignal): Promise<void> {
    const next = this.queue.then(() => this.runNow(job, signal));
    this.queue = next.catch(() => undefined);
    return next;
  }

  close(): void {
    this.stop();
  }

  private async runNow(job: Job, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new AiProviderError(`${this.options.label} aborted`, true, "TIMEOUT");
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.options.slot?.claim(this);
    try {
      const child = await this.start(signal);
      const id = randomUUID();
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          this.stop();
          reject(new AiProviderError(`${this.options.label} aborted`, true, "TIMEOUT"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        const done = () => signal.removeEventListener("abort", onAbort);
        this.pending.set(id, {
          process: child,
          resolve: () => {
            done();
            resolve();
          },
          reject: (error) => {
            done();
            reject(error);
          },
        });
        child.stdin.write(`${JSON.stringify({ id, ...job })}\n`);
      });
    } finally {
      this.idleTimer = setTimeout(() => this.stop(), this.options.idleMs ?? 600_000);
      this.idleTimer.unref();
    }
  }

  private start(signal: AbortSignal): Promise<ModelProcess> {
    const running = this.child;
    if (running && this.ready) return this.ready.then(() => running);
    const child = this.spawnModel(this.options.python, [this.options.script, ...this.options.args], {
      ...this.options.env,
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      PYTHONNOUSERSITE: "1",
      PYTHONUNBUFFERED: "1",
      // Never reach the network: everything was downloaded and checked by the setup.
      HF_HUB_OFFLINE: "1",
    });
    this.child = child;
    // Writing to a process that just died fails here; its "exit" reports it.
    child.stdin.on("error", () => undefined);
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stop();
        reject(new AiProviderError(`${this.options.label} model took too long to load`, true, "TIMEOUT"));
      }, this.options.loadTimeoutMs ?? 300_000);
      const onAbort = () => {
        clearTimeout(timer);
        this.stop();
        reject(new AiProviderError(`${this.options.label} aborted`, true, "TIMEOUT"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      createInterface({ input: child.stdout }).on("line", (line) => {
        const reply = parseReply(line);
        if (!reply) return;
        if ("ready" in reply) {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve();
          return;
        }
        const waiting = reply.id ? this.pending.get(reply.id) : undefined;
        if (!waiting || !reply.id) return;
        this.pending.delete(reply.id);
        if (reply.ok) waiting.resolve();
        else waiting.reject(new AiProviderError(`${this.options.label} failed (${reply.error})`, reply.error !== "INVALID_REQUEST"));
      });
      child.once("exit", () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (this.child === child) {
          this.child = null;
          this.ready = null;
        }
        const stopped = new AiProviderError(`${this.options.label} model stopped`, true);
        reject(stopped);
        // Only this process's jobs: a killed process may exit after its replacement has started.
        for (const [id, waiting] of this.pending) {
          if (waiting.process !== child) continue;
          this.pending.delete(id);
          waiting.reject(stopped);
        }
      });
      child.once("error", () => {
        // The Python couldn't be started (setup missing): "exit" may not follow.
        clearTimeout(timer);
        this.child = null;
        this.ready = null;
        reject(new AiProviderError(`${this.options.label} model couldn't start`, true));
      });
    });
    return this.ready.then(() => child);
  }

  private stop(): void {
    const child = this.child;
    this.child = null;
    this.ready = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    child?.kill("SIGKILL");
  }
}

function parseReply(line: string): z.infer<typeof replySchema> | null {
  try {
    const parsed = replySchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
