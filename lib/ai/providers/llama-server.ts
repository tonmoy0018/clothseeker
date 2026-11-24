import { spawn as nodeSpawn } from "node:child_process";
import { createServer } from "node:net";

import { AiProviderError } from "../errors";
import type { FetchLike } from "./http";
import type { LoadedModel, ModelSlot } from "./model-slot";

// llama.cpp's `llama-server` holding the local planner model: started on the first request, kept loaded
// between requests, stopped when idle, when a request runs out of time (a stuck model can't be
// interrupted otherwise) or when another big model needs the memory (ModelSlot). It listens only on
// this machine, gets only the variables it needs (never the worker's keys), runs offline, and nothing
// it prints reaches our logs.

/** What the manager uses of the server's child process (a fake in tests). */
export type ServerProcess = {
  kill(signal: NodeJS.Signals): boolean;
  once(event: "exit", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
};
export type SpawnServer = (bin: string, args: string[], env: Record<string, string>) => ServerProcess;

const defaultSpawn: SpawnServer = (bin, args, env) => nodeSpawn(bin, args, { env: { ...env, NODE_ENV: process.env.NODE_ENV }, stdio: "ignore" });

/** A port nothing listens on right now (the server binds it a moment later). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

export type LlamaServerOptions = {
  /** The `llama-server` program and the model files `pnpm llm:setup` checked. */
  bin: string;
  model: string;
  mmproj: string;
  /** How many tokens of request and answer the model may hold; more takes more memory. */
  contextTokens: number;
  /** Stop the server after this long without a request, giving the memory back. */
  idleMs?: number;
  /** Limit for loading the model. */
  loadTimeoutMs?: number;
  slot?: ModelSlot;
  spawn?: SpawnServer;
  fetch?: FetchLike;
  pickPort?: () => Promise<number>;
  /** How often the loading server is asked whether it's ready. */
  pollMs?: number;
};

type Running = { child: ServerProcess; url: string; ready: Promise<void> };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class LlamaServerProcess implements LoadedModel {
  private running: Running | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly spawnServer: SpawnServer;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: LlamaServerOptions) {
    this.spawnServer = options.spawn ?? defaultSpawn;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** The loaded server's address (http://127.0.0.1:port), starting it if needed. Call `release` after the request. */
  async baseUrl(signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new AiProviderError("local planner aborted", true, "TIMEOUT");
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.options.slot?.claim(this);
    const running = this.running ?? (await this.start());
    const onAbort = () => this.close();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await running.ready;
    } catch (error) {
      if (signal.aborted) throw new AiProviderError("local planner aborted", true, "TIMEOUT");
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    return running.url;
  }

  /** The request is over: the idle countdown starts. */
  release(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), this.options.idleMs ?? 300_000);
    this.idleTimer.unref();
  }

  close(): void {
    const running = this.running;
    this.running = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    running?.child.kill("SIGKILL");
  }

  private async start(): Promise<Running> {
    const port = await (this.options.pickPort ?? freePort)();
    const url = `http://127.0.0.1:${port}`;
    const child = this.spawnServer(
      this.options.bin,
      [
        "--model", this.options.model,
        "--mmproj", this.options.mmproj,
        "--host", "127.0.0.1",
        "--port", String(port),
        "--ctx-size", String(this.options.contextTokens),
        // One request at a time, the whole model on the Mac's GPU.
        "--parallel", "1",
        "--gpu-layers", "999",
        // Short structured answers: the model's "thinking" would only make them slow.
        "--reasoning-budget", "0",
        // Everything it needs is on disk; no web page, no prompt cache kept in memory, nothing logged.
        "--offline",
        "--no-webui",
        "--no-slots",
        "--cache-ram", "0",
        "--log-disable",
        // A server left behind by a killed worker gives its memory back by itself.
        "--sleep-idle-seconds", "600",
      ],
      { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    );
    let stopped: Error | null = null;
    const forget = (error: Error) => {
      stopped = error;
      if (this.running?.child === child) this.running = null;
    };
    child.once("exit", () => forget(new AiProviderError("local planner model stopped", true)));
    // The program couldn't be started (llama.cpp missing): "exit" may not follow.
    child.once("error", () => forget(new AiProviderError("local planner model couldn't start", true)));

    const deadline = Date.now() + (this.options.loadTimeoutMs ?? 120_000);
    const ready = (async () => {
      for (;;) {
        if (stopped) throw stopped;
        if (Date.now() > deadline) {
          if (this.running?.child === child) this.close();
          else child.kill("SIGKILL");
          throw new AiProviderError("local planner model took too long to load", true, "TIMEOUT");
        }
        // Answers 503 while the model loads, 200 once it can take requests.
        const ok = await this.fetchImpl(`${url}/health`, { method: "GET" }).then(
          (response) => response.ok,
          () => false,
        );
        if (ok) return;
        await sleep(this.options.pollMs ?? 250);
      }
    })();
    // Waited on by every request; one that isn't waiting must not crash the worker.
    ready.catch(() => undefined);
    const running = { child, url, ready };
    this.running = running;
    return running;
  }
}
