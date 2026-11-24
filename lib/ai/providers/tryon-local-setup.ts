import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// What the local try-on (lib/ai/providers/tryon-local.ts) needs on disk, shared by `pnpm tryon:setup`
// (scripts/setup-local-tryon.ts), which downloads and checks it, and the worker, which refuses to start
// without it. About 2.3 GB of models plus a Python with PyTorch, kept outside the project folder (it
// sits on an iCloud-synced Desktop) in ~/.cache/clothseeker/local-tryon unless LOCAL_TRYON_DIR says so.

export type LocalTryOnFile = {
  repo: string;
  /** Pinned commit, so a changed upstream file can't slip in. */
  revision: string;
  file: string;
  sha256: string;
  bytes: number;
  licence: string;
};

/**
 * Safetensors and JSON only (never pickles). Stable Diffusion 1.5 inpainting (UNet, fp16) is the base;
 * CatVTON's DressCode weights (trained at 512×384, the size we run at) replace its self-attention; the
 * LCM-LoRA lets it finish in 8 steps (the "lcm" sampler).
 */
export const LOCAL_TRYON_FILES: readonly LocalTryOnFile[] = [
  {
    repo: "stable-diffusion-v1-5/stable-diffusion-inpainting",
    revision: "8a4288a76071f7280aedbdb3253bdb9e9d5d84bb",
    file: "unet/config.json",
    sha256: "669f6581087fac5b16c44e42c58b359a35eadf2af5691d7945480bd7ceac8e6d",
    bytes: 748,
    licence: "CreativeML OpenRAIL-M",
  },
  {
    repo: "stable-diffusion-v1-5/stable-diffusion-inpainting",
    revision: "8a4288a76071f7280aedbdb3253bdb9e9d5d84bb",
    file: "unet/diffusion_pytorch_model.fp16.safetensors",
    sha256: "24b788b4a777748377cc20364eea4ae113c8c42f4468c16bc8c02fdae5492af9",
    bytes: 1_719_154_104,
    licence: "CreativeML OpenRAIL-M",
  },
  {
    repo: "stable-diffusion-v1-5/stable-diffusion-inpainting",
    revision: "8a4288a76071f7280aedbdb3253bdb9e9d5d84bb",
    file: "scheduler/scheduler_config.json",
    sha256: "8b457848b74deeeab2a967b75048dd2cb6f393cfc17751eca1b5ec655cff0183",
    bytes: 313,
    licence: "CreativeML OpenRAIL-M",
  },
  {
    repo: "stabilityai/sd-vae-ft-mse",
    revision: "31f26fdeee1355a5c34592e401dd41e45d25a493",
    file: "config.json",
    sha256: "92d3dfb746fca211a2c9e019e285f8597412211728dce3c5bcf4eda0f2d62e7e",
    bytes: 547,
    licence: "MIT",
  },
  {
    repo: "stabilityai/sd-vae-ft-mse",
    revision: "31f26fdeee1355a5c34592e401dd41e45d25a493",
    file: "diffusion_pytorch_model.safetensors",
    sha256: "a1d993488569e928462932c8c38a0760b874d166399b14414135bd9c42df5815",
    bytes: 334_643_276,
    licence: "MIT",
  },
  {
    repo: "zhengchong/CatVTON",
    revision: "2969fcf85fe62f2036605716f0b56f0b81d01d79",
    file: "dresscode-16k-512/attention/model.safetensors",
    sha256: "d65a6c64a9bc48e8009a0006d5272b9332c1077c9c2a74302cbac9f256e84cbf",
    bytes: 198_303_368,
    licence: "CC BY-NC-SA 4.0 (non-commercial)",
  },
  {
    repo: "latent-consistency/lcm-lora-sdv1-5",
    revision: "cf2fced511dbe7e26c8d1d397e728fbab875db4b",
    file: "pytorch_lora_weights.safetensors",
    sha256: "8f90d840e075ff588a58e22c6586e2ae9a6f7922996ee6649a7f01072333afe4",
    bytes: 134_621_556,
    licence: "CreativeML Open RAIL++-M",
  },
];

/** The Python and packages the model process was tested with. */
export const LOCAL_TRYON_PYTHON = "3.11";
export const LOCAL_TRYON_PACKAGES = ["torch==2.6.0", "diffusers==0.31.0", "accelerate==1.15.0", "safetensors==0.8.0", "pillow==13.0.0", "numpy==2.1.3", "huggingface-hub==2.4.0"] as const;

/** Where a file goes under the weights folder: the repo's name, then its path. */
export function localTryOnFilePath(weights: string, file: LocalTryOnFile): string {
  return path.join(weights, file.repo.split("/")[1] ?? file.repo, file.file);
}

export type LocalTryOnPaths = { root: string; python: string; weights: string; verified: string };

export function localTryOnPaths(dir: string | undefined): LocalTryOnPaths {
  const root = dir ?? path.join(homedir(), ".cache", "clothseeker", "local-tryon");
  return { root, python: path.join(root, "venv", "bin", "python"), weights: path.join(root, "weights"), verified: path.join(root, "verified.json") };
}

/** The setup's record of what it checked (hashes are checked once, by the setup; sizes on every start). */
export function verifiedRecord(): string {
  return JSON.stringify({ files: LOCAL_TRYON_FILES.map((f) => f.sha256), packages: LOCAL_TRYON_PACKAGES });
}

/** Whether `pnpm tryon:setup` finished for this exact list of files and packages. */
export function localTryOnReady(paths: LocalTryOnPaths): boolean {
  try {
    if (!existsSync(paths.python) || readFileSync(paths.verified, "utf8") !== verifiedRecord()) return false;
    return LOCAL_TRYON_FILES.every((file) => statSync(localTryOnFilePath(paths.weights, file)).size === file.bytes);
  } catch {
    return false;
  }
}
