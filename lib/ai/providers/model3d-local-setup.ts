import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { localTryOnFilePath, type LocalTryOnFile } from "./tryon-local-setup";

// What the 3D view's model on this machine (lib/ai/providers/model3d-local.ts) needs on disk, shared by
// `pnpm model3d:setup` (scripts/setup-local-3d.ts), which downloads and checks it, and the worker, which
// refuses to start without it. TripoSR's code at a pinned commit, its weights (1.7 GB, converted to
// safetensors by the setup) and a Python with PyTorch, in ~/.cache/clothseeker/local-3d unless
// LOCAL_3D_DIR says so (never in the project folder: it sits on an iCloud-synced Desktop).

/** TripoSR's code (MIT): cloned at this commit, which git checks by its hash. */
export const TRIPOSR_SOURCE = { repo: "https://github.com/VAST-AI-Research/TripoSR", commit: "107cefdc244c39106fa830359024f6a2f1c78871", licence: "MIT" } as const;

/**
 * The weights come as a PyTorch pickle (`model.ckpt`): the setup checks its SHA-256, loads it with
 * PyTorch's safe loader (tensors only, no code) and keeps a safetensors copy, then deletes the pickle.
 * The model process only ever reads the safetensors. DINO's config.json describes the image encoder (its
 * weights are inside TripoSR's).
 */
export const LOCAL_3D_FILES: readonly LocalTryOnFile[] = [
  {
    repo: "stabilityai/TripoSR",
    revision: "5b521936b01fbe1890f6f9baed0254ab6351c04a",
    file: "config.yaml",
    sha256: "74ca708ce086bf68e97709ea6b3d91f14717921c04691e84043f0eb8fcc68e62",
    bytes: 987,
    licence: "MIT",
  },
  {
    repo: "facebook/dino-vitb16",
    revision: "f205d5d8e640a89a2b8ef0369670dfc37cc07fc2",
    file: "config.json",
    sha256: "b87c0270b97db085fd82cf114a761fd0f62ae7914fbd407c752a2260646b689c",
    bytes: 454,
    licence: "Apache-2.0",
  },
];

/** The pickle the setup converts (never read by the model process). */
export const TRIPOSR_CHECKPOINT: LocalTryOnFile = {
  repo: "stabilityai/TripoSR",
  revision: "5b521936b01fbe1890f6f9baed0254ab6351c04a",
  file: "model.ckpt",
  sha256: "429e2c6b22a0923967459de24d67f05962b235f79cde6b032aa7ed2ffcd970ee",
  bytes: 1_677_246_742,
  licence: "MIT",
};

/** The Python and packages the model process was tested with (PyMCubes stands in for torchmcubes, which needs a C++ build). */
export const LOCAL_3D_PYTHON = "3.11";
export const LOCAL_3D_PACKAGES = [
  "torch==2.6.0",
  "transformers==4.35.0",
  "huggingface-hub==0.17.3",
  "omegaconf==2.3.0",
  "einops==0.7.0",
  "trimesh==4.0.5",
  "PyMCubes==0.1.6",
  "scipy==1.17.1",
  "imageio==2.34.2",
  "pillow==10.4.0",
  "numpy==1.26.4",
  "safetensors==0.8.0",
] as const;

export type Local3dPaths = { root: string; python: string; source: string; weights: string; safetensors: string; verified: string };

export function local3dPaths(dir: string | undefined): Local3dPaths {
  const root = dir ?? path.join(homedir(), ".cache", "clothseeker", "local-3d");
  const weights = path.join(root, "weights");
  return {
    root,
    python: path.join(root, "venv", "bin", "python"),
    source: path.join(root, "src"),
    weights,
    safetensors: path.join(weights, "TripoSR", "model.safetensors"),
    verified: path.join(root, "verified.json"),
  };
}

/** The setup's record of what it checked. */
export function local3dVerifiedRecord(): string {
  return JSON.stringify({ source: TRIPOSR_SOURCE.commit, checkpoint: TRIPOSR_CHECKPOINT.sha256, files: LOCAL_3D_FILES.map((f) => f.sha256), packages: LOCAL_3D_PACKAGES });
}

/** Whether `pnpm model3d:setup` finished for this exact code, weights and packages. */
export function local3dReady(paths: Local3dPaths): boolean {
  try {
    if (!existsSync(paths.python) || !existsSync(path.join(paths.source, "tsr", "system.py")) || readFileSync(paths.verified, "utf8") !== local3dVerifiedRecord()) return false;
    return statSync(paths.safetensors).size > 1_000_000_000 && LOCAL_3D_FILES.every((file) => statSync(localTryOnFilePath(paths.weights, file)).size === file.bytes);
  } catch {
    return false;
  }
}
