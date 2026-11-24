import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadEnvConfig } from "@next/env";

import { LOCAL_3D_FILES, LOCAL_3D_PACKAGES, LOCAL_3D_PYTHON, local3dPaths, local3dVerifiedRecord, TRIPOSR_CHECKPOINT, TRIPOSR_SOURCE } from "@/lib/ai/providers/model3d-local-setup";
import { localTryOnFilePath } from "@/lib/ai/providers/tryon-local-setup";

import { correct, download } from "./pinned-download";

// Sets up the 3D view's model on this machine (MODEL3D_PROVIDER=local, lib/ai/providers/model3d-local.ts):
// a Python with the pinned packages, TripoSR's code at a pinned commit, and its weights from Hugging Face
// at a pinned revision, checked against their SHA-256 and converted from a pickle to safetensors with
// PyTorch's safe loader. About 1.7 GB of weights and 1 GB of packages, in ~/.cache/clothseeker/local-3d
// (or LOCAL_3D_DIR). Safe to run again: what's already in place is kept.
//
//   pnpm model3d:setup

function log(fields: Record<string, string | number | boolean>) {
  console.log(JSON.stringify({ msg: "model3d.setup", ...fields }));
}

function has(command: string): boolean {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** The environment Python gets here: no keys, no user packages, offline. */
const pythonEnv = () => ({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PYTHONNOUSERSITE: "1", HF_HUB_OFFLINE: "1", NODE_ENV: process.env.NODE_ENV });

/** Loads the checked pickle with PyTorch's safe loader (tensors only) and writes it as safetensors. */
const CONVERT = `
import sys, torch
from safetensors.torch import save_file
state = torch.load(sys.argv[1], map_location="cpu", weights_only=True)
save_file({k: v.contiguous() for k, v in state.items()}, sys.argv[2])
`;

async function main() {
  loadEnvConfig(process.cwd());
  const paths = local3dPaths(process.env.LOCAL_3D_DIR || undefined);
  await mkdir(paths.root, { recursive: true });
  await rm(paths.verified, { force: true });

  // 1. Python and packages. uv (https://docs.astral.sh/uv/) fetches the right Python if needed.
  const venv = path.join(paths.root, "venv");
  if (has("uv")) {
    if (!existsSync(paths.python)) execFileSync("uv", ["venv", "--quiet", "--python", LOCAL_3D_PYTHON, venv], { stdio: "inherit" });
    execFileSync("uv", ["pip", "install", "--quiet", "--python", paths.python, ...LOCAL_3D_PACKAGES], { stdio: "inherit" });
  } else if (has(`python${LOCAL_3D_PYTHON}`)) {
    if (!existsSync(paths.python)) execFileSync(`python${LOCAL_3D_PYTHON}`, ["-m", "venv", venv], { stdio: "inherit" });
    execFileSync(paths.python, ["-m", "pip", "install", "--quiet", ...LOCAL_3D_PACKAGES], { stdio: "inherit" });
  } else {
    throw new Error(`Install uv (brew install uv) or Python ${LOCAL_3D_PYTHON} first`);
  }
  log({ python: true });

  // 2. TripoSR's code at the pinned commit (git checks it by its hash).
  const head = () => {
    try {
      return execFileSync("git", ["-C", paths.source, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  if (head() !== TRIPOSR_SOURCE.commit) {
    await rm(paths.source, { recursive: true, force: true });
    await mkdir(paths.source, { recursive: true });
    execFileSync("git", ["-C", paths.source, "init", "--quiet"], { stdio: "inherit" });
    execFileSync("git", ["-C", paths.source, "fetch", "--quiet", "--depth", "1", TRIPOSR_SOURCE.repo, TRIPOSR_SOURCE.commit], { stdio: "inherit" });
    execFileSync("git", ["-C", paths.source, "checkout", "--quiet", "FETCH_HEAD"], { stdio: "inherit" });
    if (head() !== TRIPOSR_SOURCE.commit) throw new Error("TripoSR's code isn't at the pinned commit");
  }
  log({ source: TRIPOSR_SOURCE.commit });

  // 3. Weights: the small files, then the checkpoint, converted once and then deleted.
  for (const file of LOCAL_3D_FILES) {
    const to = localTryOnFilePath(paths.weights, file);
    if (await correct(to, file)) continue;
    log({ downloading: `${file.repo}/${file.file}`, bytes: file.bytes });
    await download(file, to, "lib/ai/providers/model3d-local-setup.ts");
  }
  if (!existsSync(paths.safetensors)) {
    const checkpoint = localTryOnFilePath(paths.weights, TRIPOSR_CHECKPOINT);
    if (!(await correct(checkpoint, TRIPOSR_CHECKPOINT))) {
      log({ downloading: `${TRIPOSR_CHECKPOINT.repo}/${TRIPOSR_CHECKPOINT.file}`, bytes: TRIPOSR_CHECKPOINT.bytes });
      await download(TRIPOSR_CHECKPOINT, checkpoint, "lib/ai/providers/model3d-local-setup.ts");
    }
    const partial = `${paths.safetensors}.part`;
    execFileSync(paths.python, ["-c", CONVERT, checkpoint, partial], { stdio: "inherit", env: pythonEnv() });
    await rename(partial, paths.safetensors);
    await rm(checkpoint, { force: true });
    log({ converted: true });
  }
  log({ models: true });

  // 4. The model's packages and code load, and whether the Mac's GPU (MPS) is available.
  const device = execFileSync(
    paths.python,
    ["-c", "import sys; sys.path[:0] = sys.argv[1:]; import torch, trimesh, mcubes, omegaconf, tsr.system; print('mps' if torch.backends.mps.is_available() else 'cpu')", path.join(process.cwd(), "worker", "local-3d", "shim"), paths.source],
    { encoding: "utf8", env: pythonEnv() },
  ).trim();
  await writeFile(paths.verified, local3dVerifiedRecord());
  log({ ready: true, device, dir: paths.root });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
