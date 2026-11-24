import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { LocalTryOnFile } from "./tryon-local-setup";

// What the local planner (PLANNER_PROVIDER=local, lib/ai/providers/planner-local.ts) needs on disk, shared
// by `pnpm llm:setup` (scripts/setup-local-llm.ts), which downloads and checks it, and the worker, which
// refuses to start without it. About 3.4 GB, kept outside the project folder (it sits on an iCloud-synced
// Desktop) in ~/.cache/clothseeker/local-llm unless LOCAL_LLM_DIR says so. The model runs in llama.cpp's
// `llama-server` (`brew install llama.cpp`), which the worker starts and stops itself.

/**
 * Qwen3.5-4B (Apache-2.0), 4-bit: the strongest open vision-language model that fits beside the local
 * Supabase stack on an 8 GB Mac. It reads text and photos; the second file is its picture encoder.
 * GGUF files hold weights and settings only (no code).
 */
export const LOCAL_LLM_FILES = {
  model: {
    repo: "unsloth/Qwen3.5-4B-GGUF",
    revision: "e87f176479d0855a907a41277aca2f8ee7a09523",
    file: "Qwen3.5-4B-Q4_K_M.gguf",
    sha256: "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4",
    bytes: 2_740_937_888,
    licence: "Apache-2.0",
  },
  mmproj: {
    repo: "unsloth/Qwen3.5-4B-GGUF",
    revision: "e87f176479d0855a907a41277aca2f8ee7a09523",
    file: "mmproj-F16.gguf",
    sha256: "cd88edcf8d031894960bb0c9c5b9b7e1fea6ebee02b9f7ce925a00d12891f864",
    bytes: 672_423_616,
    licence: "Apache-2.0",
  },
} as const satisfies Record<string, LocalTryOnFile>;

export type LocalLlmPaths = { root: string; model: string; mmproj: string; verified: string };

export function localLlmPaths(dir: string | undefined): LocalLlmPaths {
  const root = dir ?? path.join(homedir(), ".cache", "clothseeker", "local-llm");
  return { root, model: path.join(root, LOCAL_LLM_FILES.model.file), mmproj: path.join(root, LOCAL_LLM_FILES.mmproj.file), verified: path.join(root, "verified.json") };
}

/** The setup's record of what it checked (hashes are checked once, by the setup; sizes on every start). */
export function localLlmVerifiedRecord(): string {
  return JSON.stringify({ files: Object.values(LOCAL_LLM_FILES).map((f) => f.sha256) });
}

/** Whether `pnpm llm:setup` finished for exactly these files. */
export function localLlmReady(paths: LocalLlmPaths): boolean {
  try {
    if (readFileSync(paths.verified, "utf8") !== localLlmVerifiedRecord()) return false;
    return statSync(paths.model).size === LOCAL_LLM_FILES.model.bytes && statSync(paths.mmproj).size === LOCAL_LLM_FILES.mmproj.bytes;
  } catch {
    return false;
  }
}

/** The `llama-server` program: the given path, or the first one on PATH. Null when there is none. */
export function findLlamaServer(configured: string | undefined, searchPath = process.env.PATH ?? ""): string | null {
  if (configured) return existsSync(configured) ? configured : null;
  for (const dir of searchPath.split(path.delimiter)) {
    const candidate = path.join(dir, "llama-server");
    if (dir && existsSync(candidate)) return candidate;
  }
  return null;
}
