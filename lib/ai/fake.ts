import { createHash } from "node:crypto";

import sharp from "sharp";

import { PATTERNS } from "@/lib/catalog/patterns";
import { STYLE_GROUPS } from "@/types/template";

import type { BrandLogoCheck, ImageProvider, MotifRequest, PlannerProvider, PlanRequest, ProviderImage } from "./types";

// Deterministic stand-ins for the real providers. The default for development, tests and CI:
// no keys, no network, and the same request always gives the same answer.
//
// Testing convention: FakePlanner reports a brand logo for any photo whose dominant color is the
// marker red #E4002B. Real logo detection comes from Gemini (lib/ai/gemini.ts).

export const FAKE_LOGO_MARKER = "#e4002b";

/** Waits `ms`, or rejects as soon as the job is aborted. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function bytes(seed: string): Buffer {
  return createHash("sha256").update(seed).digest();
}

const MOTIFS = [
  { word: "flower", match: /flor|flower|bloom|rose|petal/ },
  { word: "star", match: /star|sparkl|night|galax/ },
  { word: "heart", match: /heart|love|valentin/ },
  { word: "butterfly", match: /butterfl/ },
  { word: "leaf", match: /leaf|leaves|botanic|green|forest/ },
  { word: "moon", match: /moon|evening|lunar/ },
] as const;

function motifWord(text: string, fallback: number): string {
  return MOTIFS.find((m) => m.match.test(text))?.word ?? MOTIFS[fallback % MOTIFS.length]?.word ?? "flower";
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
}

export class FakePlanner implements PlannerProvider {
  readonly name = "fake";

  constructor(private readonly delayMs = 0) {}

  async detectBrandLogos(images: ProviderImage[], signal: AbortSignal): Promise<BrandLogoCheck> {
    await delay(Math.min(this.delayMs, 300), signal);
    const marker = Number.parseInt(FAKE_LOGO_MARKER.slice(1), 16);
    for (const image of images) {
      const { dominant } = await sharp(image.data).stats();
      const distance = Math.hypot(dominant.r - ((marker >> 16) & 255), dominant.g - ((marker >> 8) & 255), dominant.b - (marker & 255));
      if (distance < 48) {
        return { detected: true, label: "test brand marker" };
      }
    }
    return { detected: false };
  }

  async planDesign(request: PlanRequest, signal: AbortSignal): Promise<unknown> {
    await delay(this.delayMs, signal);
    const { constraints, instruction } = request;
    const text = instruction.toLowerCase();
    const seed = bytes(`${request.seed}:${text}`);
    const at = (i: number) => seed[i % seed.length] ?? 0;
    const start = request.reference ?? request.current;

    // Colors named in the instruction come first; "dark"/"light" reorder the rest.
    let palette = [...constraints.colors];
    if (/\b(dark|darker|deep|evening)\b/.test(text)) {
      palette.sort((a, b) => luminance(a.hex) - luminance(b.hex));
    } else if (/\b(light|lighter|pastel|soft)\b/.test(text)) {
      palette.sort((a, b) => luminance(b.hex) - luminance(a.hex));
    }
    const named = palette.filter((c) => text.includes(c.name.toLowerCase()));
    palette = [...named, ...palette.filter((c) => !named.includes(c))];
    const pick = (i: number, spread: number) => palette[i % Math.min(spread, palette.length)] ?? palette[0];

    const wantedPattern = PATTERNS.find((p) => constraints.patterns.includes(p.id) && text.includes(p.label.toLowerCase().replace(/s$/, "")));
    const quoted = /["“]([^"”]{1,40})["”]/.exec(instruction)?.[1] ?? null;
    const word = motifWord(text, at(0));
    const mainRegion = [...constraints.regions].reverse().find((r) => r.id === "skirt") ?? constraints.regions[0];

    const variations = [0, 1, 2, 3].map((i) => {
      const primary = pick(named.length > 0 ? 0 : at(i + 1), named.length > 0 ? 1 : 4);
      const secondary = pick(at(i + 5) + 1, 6);
      const patternId = wantedPattern?.id ?? (i % 2 === 1 ? constraints.patterns[at(i + 9) % Math.max(constraints.patterns.length, 1)] : undefined);
      const patternColor = pick(at(i + 13) + 2, palette.length) ?? primary;
      const parts = constraints.regions.map((region, j) => {
        const color = ((j + i) % 2 === 0 ? primary : secondary)?.hex ?? start.parts.find((p) => p.regionId === region.id)?.color ?? "#ffffff";
        return {
          regionId: region.id,
          color,
          pattern: region.id === mainRegion?.id && patternId && patternColor ? { id: patternId, color: patternColor.hex } : null,
        };
      });
      const styleOptions = Object.fromEntries(
        STYLE_GROUPS.map((group) => {
          const options = constraints.styleOptions[group];
          return [group, i === 0 ? start.styleOptions[group] : (options[at(i * 3 + 17) % options.length]?.id ?? start.styleOptions[group])];
        }),
      );
      const name = primary?.name ?? "Custom";
      return {
        title: `${name} ${word} ${["classic", "bold", "soft", "statement"][i]}`,
        summary: `${name} ${mainRegion?.label.toLowerCase() ?? "dress"} with a ${word} motif.`,
        parts,
        styleOptions,
        text: quoted && constraints.layersAllowed ? { content: quoted, fontId: constraints.fonts[i % Math.max(constraints.fonts.length, 1)] ?? "inter", color: secondary?.hex ?? "#ffffff" } : null,
        motif: constraints.layersAllowed ? { prompt: `${word} motif`, color: secondary?.hex ?? "#ffffff" } : null,
      };
    });
    return { variations };
  }
}

function motifSvg(word: string, color: string, seed: number): string {
  const rotate = seed % 360;
  const shapes: Record<string, string> = {
    flower: [0, 72, 144, 216, 288].map((a) => `<ellipse cx="256" cy="150" rx="62" ry="105" transform="rotate(${a} 256 256)"/>`).join("") + `<circle cx="256" cy="256" r="52" fill-opacity="0.6"/>`,
    star: `<polygon points="256,40 316,190 476,196 350,296 394,452 256,364 118,452 162,296 36,196 196,190"/>`,
    heart: `<path d="M256 450 C 60 320 40 170 140 120 C 200 90 240 120 256 160 C 272 120 312 90 372 120 C 472 170 452 320 256 450 Z"/>`,
    butterfly: `<ellipse cx="170" cy="190" rx="95" ry="120"/><ellipse cx="342" cy="190" rx="95" ry="120"/><ellipse cx="190" cy="350" rx="70" ry="85"/><ellipse cx="322" cy="350" rx="70" ry="85"/><rect x="246" y="130" width="20" height="300" rx="10"/>`,
    leaf: `<path d="M256 470 C 90 360 90 140 256 40 C 422 140 422 360 256 470 Z"/><rect x="250" y="120" width="12" height="340" fill-opacity="0.5"/>`,
    moon: `<path d="M330 60 A 200 200 0 1 0 330 452 A 160 160 0 1 1 330 60 Z"/>`,
  };
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">` +
    `<g fill="${color}" transform="rotate(${rotate} 256 256)">${shapes[word] ?? shapes.flower}</g></svg>`
  );
}

export class FakeImage implements ImageProvider {
  readonly name = "fake";

  constructor(private readonly delayMs = 0) {}

  async generateMotif(request: MotifRequest, signal: AbortSignal): Promise<Buffer> {
    await delay(Math.round(this.delayMs / 4), signal);
    const color = /^#[0-9a-f]{6}$/i.test(request.color) ? request.color : "#333333";
    const word = motifWord(request.prompt.toLowerCase(), request.seed);
    return sharp(Buffer.from(motifSvg(word, color, request.seed))).png().toBuffer();
  }
}
