import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { modelPath, modelSourceUrl, ORT_FILES, ORT_PATH, ORT_VERSION, VISION_BASE, VISION_MODELS } from "@/lib/vision/assets";

// Puts the on-device vision files into public/vision/ (git-ignored): the Hugging Face models, checked
// against their pinned SHA-256, and ONNX Runtime Web's files from node_modules. Safe to run repeatedly:
// files that are already correct are left alone. Runs before `next dev` and `next build`.
//
//   pnpm vision:fetch

const PUBLIC = path.join(process.cwd(), "public");

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

function log(fields: Record<string, string | number | boolean>) {
  console.log(JSON.stringify({ msg: "vision.fetch", ...fields }));
}

async function main() {
  const installed = z
    .object({ version: z.string() })
    .parse(JSON.parse(await readFile(path.join(process.cwd(), "node_modules", "onnxruntime-web", "package.json"), "utf8")));
  if (installed.version !== ORT_VERSION) {
    throw new Error(`onnxruntime-web ${installed.version} is installed, but lib/vision/assets.ts expects ${ORT_VERSION}`);
  }

  // Start clean, so files of older versions or models don't linger.
  const root = path.join(PUBLIC, VISION_BASE);
  const wanted = new Set([...ORT_FILES.map((f) => path.join(PUBLIC, ORT_PATH, f)), ...Object.values(VISION_MODELS).map((m) => path.join(PUBLIC, modelPath(m)))]);
  if (existsSync(root)) {
    const all = (await readdir(root, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
    for (const file of all) if (!wanted.has(file)) await rm(file);
  }

  await mkdir(path.join(PUBLIC, ORT_PATH), { recursive: true });
  for (const file of ORT_FILES) {
    const from = path.join(process.cwd(), "node_modules", "onnxruntime-web", "dist", file);
    const to = path.join(PUBLIC, ORT_PATH, file);
    if (existsSync(to) && sha256(await readFile(to)) === sha256(await readFile(from))) continue;
    await copyFile(from, to);
    log({ copied: file });
  }

  await mkdir(path.join(PUBLIC, VISION_BASE, "models"), { recursive: true });
  for (const model of Object.values(VISION_MODELS)) {
    const to = path.join(PUBLIC, modelPath(model));
    if (existsSync(to) && sha256(await readFile(to)) === model.sha256) continue;
    const response = await fetch(modelSourceUrl(model));
    if (!response.ok) throw new Error(`Downloading ${model.repo}/${model.file} failed: HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (sha256(data) !== model.sha256) {
      throw new Error(`${model.repo}/${model.file} changed on Hugging Face (SHA-256 mismatch); check it before updating lib/vision/assets.ts`);
    }
    await writeFile(to, data);
    log({ downloaded: model.id, bytes: data.length });
  }
  log({ ready: true });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
