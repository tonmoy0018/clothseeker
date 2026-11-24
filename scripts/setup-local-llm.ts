import { mkdir, rm, writeFile } from "node:fs/promises";

import { loadEnvConfig } from "@next/env";

import { findLlamaServer, LOCAL_LLM_FILES, localLlmPaths, localLlmVerifiedRecord } from "@/lib/ai/providers/local-llm-setup";

import { correct, download } from "./pinned-download";

// Sets up the local planner (PLANNER_PROVIDER=local, lib/ai/providers/planner-local.ts) on this machine:
// the model files from Hugging Face at a pinned commit, each checked against its SHA-256. About 3.4 GB,
// in ~/.cache/clothseeker/local-llm (or LOCAL_LLM_DIR). Safe to run again: files that are already
// correct are kept. The program that runs the model is llama.cpp's llama-server: `brew install llama.cpp`.
//
//   pnpm llm:setup

function log(fields: Record<string, string | number | boolean>) {
  console.log(JSON.stringify({ msg: "llm.setup", ...fields }));
}

async function main() {
  loadEnvConfig(process.cwd());
  const paths = localLlmPaths(process.env.LOCAL_LLM_DIR || undefined);
  await mkdir(paths.root, { recursive: true });
  await rm(paths.verified, { force: true });

  for (const [file, to] of [
    [LOCAL_LLM_FILES.model, paths.model],
    [LOCAL_LLM_FILES.mmproj, paths.mmproj],
  ] as const) {
    if (await correct(to, file)) continue;
    log({ downloading: `${file.repo}/${file.file}`, bytes: file.bytes });
    await download(file, to, "lib/ai/providers/local-llm-setup.ts");
  }
  await writeFile(paths.verified, localLlmVerifiedRecord());

  const bin = findLlamaServer(process.env.LLAMA_SERVER_BIN || undefined);
  log({ ready: true, dir: paths.root, llamaServer: bin ?? "missing: run `brew install llama.cpp`" });
  if (!bin) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
