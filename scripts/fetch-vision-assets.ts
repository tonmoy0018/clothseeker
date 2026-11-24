import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

import { z } from "zod";

import { modelPath, modelSourceUrl, ORT_FILES, ORT_PATH, ORT_VERSION, VISION_BASE, VISION_MODELS } from "@/lib/vision/runtime/assets";

// Puts the on-device vision files into public/vision/ (git-ignored): the models (from Hugging Face, or
// from a zip on the maker's own site), checked against their pinned SHA-256, and ONNX Runtime Web's files
// from node_modules. Safe to run repeatedly:
// files that are already correct are left alone. Runs before `next dev` and `next build`.
//
//   pnpm vision:fetch

const PUBLIC = path.join(process.cwd(), "public");

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** One file out of a zip (stored or deflated), found through the zip's central directory. */
function zipEntry(zip: Buffer, name: string): Buffer {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("not a zip file");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("damaged zip directory");
    const method = zip.readUInt16LE(at + 10);
    const packed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    if (zip.toString("utf8", at + 46, at + 46 + nameLength) === name) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + packed);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`unsupported zip compression ${method}`);
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`${name} is not in the zip`);
}

function log(fields: Record<string, string | number | boolean>) {
  console.log(JSON.stringify({ msg: "vision.fetch", ...fields }));
}

async function main() {
  const installed = z
    .object({ version: z.string() })
    .parse(JSON.parse(await readFile(path.join(process.cwd(), "node_modules", "onnxruntime-web", "package.json"), "utf8")));
  if (installed.version !== ORT_VERSION) {
    throw new Error(`onnxruntime-web ${installed.version} is installed, but lib/vision/runtime/assets.ts expects ${ORT_VERSION}`);
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
    const download = Buffer.from(await response.arrayBuffer());
    const data = model.archive ? zipEntry(download, model.file) : download;
    if (sha256(data) !== model.sha256) {
      throw new Error(`${model.repo}/${model.file} changed at its source (SHA-256 mismatch); check it before updating lib/vision/runtime/assets.ts`);
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
