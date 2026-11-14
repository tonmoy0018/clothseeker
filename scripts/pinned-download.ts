import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { finished, pipeline } from "node:stream/promises";

import type { LocalTryOnFile } from "@/lib/ai/providers/tryon-local-setup";

// Downloading model files from Hugging Face at a pinned commit and checking them against their pinned
// SHA-256, for the setup scripts (setup-local-tryon.ts, setup-local-llm.ts).

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/** Whether the file on disk is exactly the pinned one. */
export async function correct(file: string, expected: LocalTryOnFile): Promise<boolean> {
  return existsSync(file) && (await stat(file)).size === expected.bytes && (await sha256(file)) === expected.sha256;
}

/** Streams the file to disk (never all in memory) and only keeps it when its SHA-256 matches. `pinnedIn` names the file that lists it. */
export async function download(file: LocalTryOnFile, to: string, pinnedIn: string): Promise<void> {
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
    throw new Error(`${file.repo}/${file.file} doesn't match its pinned SHA-256; check it before updating ${pinnedIn}`);
  }
  await rename(partial, to);
}
