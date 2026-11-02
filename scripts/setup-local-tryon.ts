import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { finished, pipeline } from "node:stream/promises";

import { loadEnvConfig } from "@next/env";

import { LOCAL_TRYON_FILES, LOCAL_TRYON_PACKAGES, LOCAL_TRYON_PYTHON, localTryOnFilePath, localTryOnPaths, verifiedRecord, type LocalTryOnFile } from "@/lib/ai/tryon-local-setup";

// Sets up the local virtual try-on (TRYON_PROVIDER=local, lib/ai/tryon-local.ts) on this machine:
// a Python with the pinned packages, and the models from Hugging Face at pinned commits, each checked
// against its SHA-256. About 2.3 GB of models and 1 GB of packages, in ~/.cache/clothseeker/local-tryon
// (or LOCAL_TRYON_DIR). Safe to run again: files that are already correct are kept.
//
//   pnpm tryon:setup

function log(fields: Record<string, string | number | boolean>) {
  console.log(JSON.stringify({ msg: "tryon.setup", ...fields }));
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function correct(file: string, expected: LocalTryOnFile): Promise<boolean> {
  return existsSync(file) && (await stat(file)).size === expected.bytes && (await sha256(file)) === expected.sha256;
}

/** Streams the file to disk (never all in memory) and only keeps it when its SHA-256 matches. */
async function download(file: LocalTryOnFile, to: string): Promise<void> {
  const url = `https://huggingface.co/${file.repo}/resolve/${file.revision}/${file.file}`;
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Downloading ${file.repo}/${file.file} failed: HTTP ${response.status}`);
  await mkdir(path.dirname(to), { recursive: true });
  const partial = `${to}.part`;
  const reader = response.body.getReader();
  const out = createWriteStream(partial);
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    if (!out.write(chunk.value)) await once(out, "drain");
  }
  out.end();
  await finished(out);
  if (!(await correct(partial, file))) {
    await rm(partial, { force: true });
    throw new Error(`${file.repo}/${file.file} doesn't match its pinned SHA-256; check it before updating lib/ai/tryon-local-setup.ts`);
  }
  await rename(partial, to);
}

function has(command: string): boolean {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  loadEnvConfig(process.cwd());
  const paths = localTryOnPaths(process.env.LOCAL_TRYON_DIR || undefined);
  await mkdir(paths.root, { recursive: true });
  await rm(paths.verified, { force: true });

  // 1. Python and packages. uv (https://docs.astral.sh/uv/) fetches the right Python if needed.
  const venv = path.join(paths.root, "venv");
  if (has("uv")) {
    if (!existsSync(paths.python)) execFileSync("uv", ["venv", "--quiet", "--python", LOCAL_TRYON_PYTHON, venv], { stdio: "inherit" });
    execFileSync("uv", ["pip", "install", "--quiet", "--python", paths.python, ...LOCAL_TRYON_PACKAGES], { stdio: "inherit" });
  } else if (has(`python${LOCAL_TRYON_PYTHON}`)) {
    if (!existsSync(paths.python)) execFileSync(`python${LOCAL_TRYON_PYTHON}`, ["-m", "venv", venv], { stdio: "inherit" });
    execFileSync(paths.python, ["-m", "pip", "install", "--quiet", ...LOCAL_TRYON_PACKAGES], { stdio: "inherit" });
  } else {
    throw new Error(`Install uv (brew install uv) or Python ${LOCAL_TRYON_PYTHON} first`);
  }
  log({ python: true });

  // 2. Models.
  for (const file of LOCAL_TRYON_FILES) {
    const to = localTryOnFilePath(paths.weights, file);
    if (await correct(to, file)) continue;
    log({ downloading: `${file.repo}/${file.file}`, bytes: file.bytes });
    await download(file, to);
  }
  log({ models: true });

  // 3. The packages load, and whether the Mac's GPU (MPS) is available.
  const ok = execFileSync(
    paths.python,
    [
      "-c",
      "import torch, diffusers, safetensors, PIL; print('mps' if torch.backends.mps.is_available() else 'cpu')",
    ],
    { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PYTHONNOUSERSITE: "1", NODE_ENV: process.env.NODE_ENV } },
  ).trim();
  await writeFile(paths.verified, verifiedRecord());
  log({ ready: true, device: ok, dir: paths.root });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
