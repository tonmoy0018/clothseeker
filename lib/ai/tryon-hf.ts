import { Client, handle_file } from "@gradio/client";
import { z } from "zod";

import { AiProviderError } from "./errors";
import type { FetchLike } from "./http";
import type { TryOnProvider, TryOnRequest } from "./types";

// Virtual try-on on free public Hugging Face Spaces (Gradio apps on ZeroGPU), with a dress mode.
// Feasibility was checked on 2026-10-09 (ai-scripts/tryon-feasibility.ts, docs/developers/try-on.md):
// results are a rough preview, and the free GPU allowance is small and shared by the whole store.
//
// Privacy: the photo is sent to a third-party Space. Customers are told this before they consent.

type SpaceCall = { endpoint: string; args: (person: Blob, garment: Blob) => Record<string, unknown> };

export const TRYON_SPACES: Record<string, SpaceCall> = {
  "levihsu/OOTDiffusion": {
    endpoint: "/process_dc",
    args: (person, garment) => ({
      vton_img: handle_file(person),
      garm_img: handle_file(garment),
      category: "Dress",
      n_samples: 1,
      n_steps: 20,
      image_scale: 2,
      seed: 42,
    }),
  },
  "franciszzj/Leffa": {
    endpoint: "/leffa_predict_vt",
    args: (person, garment) => ({
      src_image_path: handle_file(person),
      ref_image_path: handle_file(garment),
      ref_acceleration: false,
      step: 30,
      scale: 2.5,
      seed: 42,
      vt_model_type: "dress_code",
      vt_garment_type: "dresses",
      vt_repaint: false,
    }),
  },
};

export const DEFAULT_TRYON_SPACES = Object.keys(TRYON_SPACES);

/** The minimum of a Gradio client this adapter needs (injected in tests). */
export type GradioApp = { predict(endpoint: string, data: Record<string, unknown>): Promise<{ data: unknown }> };
export type GradioConnect = (space: string, token: `hf_${string}` | undefined) => Promise<GradioApp>;

const defaultConnect: GradioConnect = (space, token) => Client.connect(space, token ? { hf_token: token } : {});

/** The first file URL anywhere in a Gradio result (images, galleries, nested lists). */
export function firstFileUrl(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = firstFileUrl(item);
      if (url) return url;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    const direct = z.object({ url: z.url({ protocol: /^https$/ }) }).safeParse(value);
    if (direct.success) return direct.data.url;
    for (const item of Object.values(value)) {
      const url = firstFileUrl(item);
      if (url) return url;
    }
  }
  return null;
}

/** ZeroGPU's daily allowance is used up (anonymous or per-account); retrying today won't help. */
export function isQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error ?? "");
  return /zerogpu quota|exceeded your .*quota|gpu quota/i.test(message);
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new AiProviderError("try-on aborted", true, "TIMEOUT"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new AiProviderError("try-on aborted", true, "TIMEOUT"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export type HuggingFaceTryOnOptions = {
  /** Space ids from TRYON_SPACES, tried in order. */
  spaces: readonly string[];
  /** Optional free Hugging Face account token: raises the ZeroGPU allowance. */
  token?: string;
  connect?: GradioConnect;
  fetch?: FetchLike;
};

export class HuggingFaceTryOn implements TryOnProvider {
  readonly name = "huggingface";
  private readonly token: `hf_${string}` | undefined;
  private readonly connect: GradioConnect;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: HuggingFaceTryOnOptions) {
    const token = options.token;
    this.token = token && /^hf_[A-Za-z0-9]{20,}$/.test(token) ? `hf_${token.slice(3)}` : undefined;
    this.connect = options.connect ?? defaultConnect;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async tryOn(request: TryOnRequest, signal: AbortSignal): Promise<Buffer> {
    const person = new Blob([new Uint8Array(request.person.data)], { type: request.person.mimeType });
    const garment = new Blob([new Uint8Array(request.garment.data)], { type: request.garment.mimeType });
    let allOverQuota = true;
    let tried = 0;
    for (const space of this.options.spaces) {
      const call = TRYON_SPACES[space];
      if (!call) {
        continue;
      }
      tried++;
      try {
        return await abortable(this.callSpace(space, call, person, garment), signal);
      } catch (error) {
        if (signal.aborted || (error instanceof AiProviderError && error.code === "TIMEOUT")) {
          throw new AiProviderError("try-on timed out", true, "TIMEOUT");
        }
        // Space errors may echo inputs, so only the kind of failure is kept.
        allOverQuota &&= isQuotaError(error);
      }
    }
    if (tried > 0 && allOverQuota) {
      throw new AiProviderError("every try-on space is over its free GPU quota", false, "TRYON_LIMIT");
    }
    throw new AiProviderError("try-on failed on every space", true);
  }

  private async callSpace(space: string, call: SpaceCall, person: Blob, garment: Blob): Promise<Buffer> {
    const app = await this.connect(space, this.token);
    const result = await app.predict(call.endpoint, call.args(person, garment));
    const url = firstFileUrl(result.data);
    if (!url) {
      throw new AiProviderError("try-on space returned no image", true);
    }
    const response = await this.fetchImpl(url, this.token ? { headers: { authorization: `Bearer ${this.token}` } } : {});
    if (!response.ok) {
      throw new AiProviderError(`try-on image download failed (HTTP ${response.status})`, true);
    }
    return Buffer.from(await response.arrayBuffer());
  }
}
