import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Client, handle_file } from "@gradio/client";
import { loadEnvConfig } from "@next/env";
import { z } from "zod";

// Feasibility check for virtual try-on on free public Hugging Face Spaces (CLAUDE.md: test the
// try-on provider before building the Phase 7 UI). Not part of the app or the worker.
//
//   pnpm tsx ai-scripts/tryon-feasibility.ts <person.jpg> <garment.png> <out-dir> [space…]
//
// Use a photo you are allowed to send to a third party (e.g. the Space's own examples).
// HF_TOKEN (optional, from .env.local) raises the free ZeroGPU allowance.

type SpaceCall = { space: string; endpoint: string; args: (person: Blob, garment: Blob) => Record<string, unknown> };

const SPACES: Record<string, SpaceCall> = {
  "franciszzj/Leffa": {
    space: "franciszzj/Leffa",
    endpoint: "/leffa_predict_vt",
    args: (person, garment) => ({
      src_image_path: handle_file(person),
      ref_image_path: handle_file(garment),
      ref_acceleration: false,
      step: 30,
      scale: 2.5,
      seed: 42,
      vt_model_type: "dress_code",
      vt_garment_type: "dresses",
      vt_repaint: false,
    }),
  },
  "levihsu/OOTDiffusion": {
    space: "levihsu/OOTDiffusion",
    endpoint: "/process_dc",
    args: (person, garment) => ({
      vton_img: handle_file(person),
      garm_img: handle_file(garment),
      category: "Dress",
      n_samples: 1,
      n_steps: 20,
      image_scale: 2,
      seed: 42,
    }),
  },
};

/** The first file URL anywhere in a Gradio result (images, galleries, nested lists). */
function firstUrl(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = firstUrl(item);
      if (url) return url;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    const direct = z.object({ url: z.string().url() }).safeParse(value);
    if (direct.success) return direct.data.url;
    for (const item of Object.values(value)) {
      const url = firstUrl(item);
      if (url) return url;
    }
  }
  return null;
}

async function main() {
  loadEnvConfig(process.cwd());
  const [personPath, garmentPath, outDir, ...names] = process.argv.slice(2);
  if (!personPath || !garmentPath || !outDir) {
    console.error("usage: tryon-feasibility.ts <person> <garment> <out-dir> [space…]");
    process.exit(2);
  }
  const token = process.env.HF_TOKEN;
  const hfToken: `hf_${string}` | undefined = token && /^hf_[A-Za-z0-9]{20,}$/.test(token) ? `hf_${token.slice(3)}` : undefined;
  const person = new Blob([await readFile(personPath)], { type: "image/jpeg" });
  const garment = new Blob([await readFile(garmentPath)], { type: "image/png" });
  await mkdir(outDir, { recursive: true });

  for (const name of names.length > 0 ? names : Object.keys(SPACES)) {
    const call = SPACES[name];
    if (!call) {
      console.log(JSON.stringify({ space: name, ok: false, error: "unknown space" }));
      continue;
    }
    const started = Date.now();
    try {
      const client = await Client.connect(call.space, hfToken ? { hf_token: hfToken } : {});
      const result = await client.predict(call.endpoint, call.args(person, garment));
      const url = firstUrl(result.data);
      if (!url) {
        throw new Error("no image in the result");
      }
      const response = await fetch(url, hfToken ? { headers: { authorization: `Bearer ${hfToken}` } } : {});
      const bytes = Buffer.from(await response.arrayBuffer());
      const out = path.join(outDir, `${name.replace("/", "_")}.webp`);
      await writeFile(out, bytes);
      console.log(JSON.stringify({ space: name, ok: true, ms: Date.now() - started, bytes: bytes.length, out }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(JSON.stringify({ space: name, ok: false, ms: Date.now() - started, error: message.slice(0, 300) }));
    }
  }
}

void main();
