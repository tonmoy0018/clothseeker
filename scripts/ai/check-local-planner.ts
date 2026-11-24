import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { loadEnvConfig } from "@next/env";

import { parsePlan, planConstraints, summarizeSpec } from "@/lib/ai/plan";
import { LlamaServerProcess } from "@/lib/ai/providers/llama-server";
import { findLlamaServer, localLlmPaths, localLlmReady } from "@/lib/ai/providers/local-llm-setup";
import { LocalPlanner } from "@/lib/ai/providers/planner-local";
import { parseGarmentReading } from "@/lib/own-dress/read";
import { TEMPLATE, validSpec } from "@/tests/fixtures/design";

// Runs the local planner (PLANNER_PROVIDER=local) on a few sample requests and prints how long each took,
// whether the answer passed our own validation, and the memory the model server used. No customer data:
// the test template and a seed photo.
//
//   pnpm tsx scripts/ai/check-local-planner.ts ["a request in your own words"]

const INSTRUCTIONS = ["Make the skirt navy and add a small gold star on the left chest", "Like a summer garden party: soft pastel florals"];

function serverMemoryMb(): number {
  const rows = execFileSync("ps", ["-axo", "rss=,comm="], { encoding: "utf8" }).split("\n");
  const kb = rows.filter((row) => row.includes("llama-server")).map((row) => Number(row.trim().split(/\s+/)[0]));
  return Math.round(Math.max(0, ...kb) / 1024);
}

async function timed<T>(label: string, run: () => Promise<T>, describe: (value: T) => Record<string, unknown>): Promise<void> {
  const started = Date.now();
  try {
    const value = await run();
    console.log(JSON.stringify({ task: label, seconds: Number(((Date.now() - started) / 1000).toFixed(1)), memoryMb: serverMemoryMb(), ...describe(value) }));
  } catch (error) {
    console.log(JSON.stringify({ task: label, seconds: Number(((Date.now() - started) / 1000).toFixed(1)), failed: error instanceof Error ? `${error.name}: ${error.message}` : "error" }));
  }
}

async function main() {
  loadEnvConfig(process.cwd());
  const paths = localLlmPaths(process.env.LOCAL_LLM_DIR || undefined);
  const bin = findLlamaServer(process.env.LLAMA_SERVER_BIN || undefined);
  if (!localLlmReady(paths) || !bin) throw new Error("Run `brew install llama.cpp` and `pnpm llm:setup` first");
  const server = new LlamaServerProcess({ bin, model: paths.model, mmproj: paths.mmproj, contextTokens: Number(process.env.LOCAL_LLM_CONTEXT ?? 8192) });
  const planner = new LocalPlanner({ server, onStats: (stats) => console.log(JSON.stringify({ stats })) });
  const signal = AbortSignal.timeout(900_000);
  const photo = { data: await readFile(path.join(process.cwd(), "prisma", "seed-photos", "block-print-maxi-dress.jpg")), mimeType: "image/jpeg" as const };
  const constraints = planConstraints(TEMPLATE, "Test dress");
  const current = summarizeSpec(validSpec());

  const own = process.argv[2];
  for (const instruction of own ? [own] : INSTRUCTIONS) {
    await timed(
      "plan",
      () => planner.planDesign({ instruction, images: [], constraints, current, reference: null, seed: "0".repeat(64) }, signal),
      (raw) => {
        const options = parsePlan(raw);
        return { instruction, valid: options.length, options: options.map((o) => ({ title: o.title, summary: o.summary })) };
      },
    );
  }
  await timed(
    "plan with a photo",
    () => planner.planDesign({ instruction: "Use the colours of the dress in my photo", images: [photo], constraints, current, reference: null, seed: "1".repeat(64) }, signal),
    (raw) => ({ valid: parsePlan(raw).length, titles: parsePlan(raw).map((o) => o.title) }),
  );
  await timed("read a garment photo", () => planner.readGarment(photo, signal), (raw) => ({ reading: parseGarmentReading(raw) }));
  await timed("brand logo check", () => planner.detectBrandLogos([photo], signal), (check) => ({ check }));
  planner.close();
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
