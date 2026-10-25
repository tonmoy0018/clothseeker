"use client";

import { ImagePlus } from "lucide-react";
import Image from "next/image";
import { useMemo, useState } from "react";

import { DECORATIONS, decorationSvg } from "@/lib/catalog/decorations";
import { PATTERNS, patternSvg, type PatternId } from "@/lib/catalog/patterns";
import { formatBDT } from "@/lib/money";
import { cn } from "@/lib/utils";
import { PRINT_TILE_CM, type DesignSpec } from "@/types/design-spec";
import type { TemplateConfig } from "@/types/template";

import { Swatch, Tile } from "./editor-ui";
import { decorationDataUrl } from "./recolor";

// Fabric tab: pick which part of the dress to colour (or the whole dress), then a fabric from a grid
// of plain colours and patterned fabrics made from the template's colours and patterns.

type Part = DesignSpec["parts"][string];
type Fabric = { key: string; name: string; colorName: string; color: string; pattern: { id: PatternId; color: string } | null };
type Filter = "all" | "plain" | "patterned";

const ALL = "__all";

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** Plain fabrics, then each pattern on each colour (printed in the most contrasting allowed colour). */
function fabricsFor(config: TemplateConfig): Fabric[] {
  const colors = config.allowedColors.map((c) => ({ name: c.name, hex: c.hex.toLowerCase() }));
  const byLight = [...colors].sort((a, b) => luminance(a.hex) - luminance(b.hex));
  const darkest = byLight[0]?.hex ?? "#1b1b1b";
  const lightest = byLight.at(-1)?.hex ?? "#f5f5f0";
  const plain = colors.map((c) => ({ key: `plain-${c.hex}`, name: c.name, colorName: c.name, color: c.hex, pattern: null }));
  const patterned = PATTERNS.filter((p) => config.allowedPatterns.includes(p.id)).flatMap((p) =>
    colors.map((c) => ({
      key: `${p.id}-${c.hex}`,
      name: `${c.name} ${p.label.toLowerCase()}`,
      colorName: c.name,
      color: c.hex,
      pattern: { id: p.id, color: luminance(c.hex) < 0.5 ? lightest : darkest },
    })),
  );
  return [...plain, ...patterned];
}

function samePart(part: Part | undefined, fabric: Fabric): boolean {
  return part !== undefined && part.color === fabric.color && (part.pattern?.id ?? null) === (fabric.pattern?.id ?? null);
}

/** CSS for a fabric swatch: the pattern itself, or the colour with a faint woven texture. */
function swatchStyle(fabric: Fabric): React.CSSProperties {
  if (fabric.pattern) {
    const svg = patternSvg(fabric.pattern.id, fabric.pattern.color, fabric.color, 160, 120, 18);
    return { backgroundImage: `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`, backgroundSize: "cover" };
  }
  return {
    backgroundColor: fabric.color,
    backgroundImage:
      "linear-gradient(135deg, rgba(255,255,255,0.16), rgba(0,0,0,0.12)), repeating-linear-gradient(45deg, rgba(255,255,255,0.07) 0 1px, transparent 1px 3px), repeating-linear-gradient(-45deg, rgba(0,0,0,0.06) 0 1px, transparent 1px 3px)",
  };
}

export function FabricTab(props: {
  config: TemplateConfig;
  spec: DesignSpec;
  /** Recolorable regions shown on this dress. */
  regions: readonly { id: string; label: string }[];
  /** What the garment is called ("Whole dress"). */
  noun: string;
  /** Signed URLs of the customer's uploads (for image prints). */
  uploadUrls: Readonly<Record<string, string>>;
  /** Upload progress text, or null when idle. */
  uploadState: string | null;
  onUpload: (file: File) => Promise<{ key: string; url: string } | null>;
  onChangeParts: (change: (parts: DesignSpec["parts"]) => DesignSpec["parts"]) => void;
}) {
  const { config, spec, regions } = props;
  const [target, setTarget] = useState<string>(ALL);
  const [filter, setFilter] = useState<Filter>("all");
  const fabrics = useMemo(() => fabricsFor(config), [config]);
  const targets = target === ALL ? regions.map((r) => r.id) : [target];
  const shown = fabrics.filter((f) => filter === "all" || (filter === "plain") === (f.pattern === null));
  const hasPatterns = config.allowedPatterns.length > 0;
  const patternPrice = `+${formatBDT(config.addOns.patternMinor)}`;

  // A plain fabric keeps the part's all-over print (it becomes the print's background); a patterned
  // fabric replaces it.
  const apply = (part: Part | null) =>
    props.onChangeParts((parts) => {
      const next = { ...parts };
      for (const id of targets) {
        const print = parts[id]?.print;
        if (part) next[id] = part.pattern || !print ? part : { ...part, print };
        else delete next[id];
      }
      return next;
    });

  // ── all-over print ──
  const lightest = [...config.allowedColors].sort((a, b) => luminance(b.hex) - luminance(a.hex))[0]?.hex.toLowerCase() ?? "#f5f5f0";
  const setPrint = (print: Part["print"] | null) =>
    props.onChangeParts((parts) => {
      const next = { ...parts };
      for (const id of targets) {
        const current = parts[id];
        // A print needs a background colour: keep the part's, or start on the lightest one.
        next[id] = print ? { color: current?.color ?? lightest, print } : { color: current?.color ?? lightest };
        if (!print && !current) delete next[id];
      }
      return next;
    });
  const prints = targets.map((id) => spec.parts[id]?.print ?? null);
  const firstPrint = prints[0] ?? null;
  const samePrint = prints.every((p) => JSON.stringify(p) === JSON.stringify(firstPrint)) ? firstPrint : null;
  const decorations = DECORATIONS.filter((d) => config.allowedDecorations.includes(d.id));
  const tileCm = samePrint?.tileCm ?? 8;

  // Fine-tune the print colour once every chosen part has the same pattern.
  const patternIds = new Set(targets.map((id) => spec.parts[id]?.pattern?.id ?? null));
  const patternColor = targets.length > 0 && patternIds.size === 1 && !patternIds.has(null) ? (spec.parts[targets[0] ?? ""]?.pattern?.color ?? null) : null;

  return (
    <div className="flex flex-col gap-4">
      {/* With a single part there's nothing to choose between. */}
      <div className={cn("flex flex-wrap gap-2", regions.length < 2 && "hidden")} role="group" aria-label="Part to color">
        {[{ id: ALL, label: `Whole ${props.noun}` }, ...regions].map((r) => (
          <button
            key={r.id}
            type="button"
            aria-pressed={target === r.id}
            onClick={() => setTarget(r.id)}
            className={cn("h-8 rounded-full border px-3 text-sm", target === r.id ? "border-foreground bg-foreground text-background" : "hover:bg-muted")}
          >
            {r.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        {hasPatterns && (
          <div className="flex rounded-lg border p-0.5" role="group" aria-label="Show fabrics">
            {(["all", "plain", "patterned"] as const).map((f) => (
              <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)} className={cn("h-7 rounded-md px-3 capitalize", filter === f ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}>
                {f}
              </button>
            ))}
          </div>
        )}
        <span className="ml-auto text-muted-foreground tabular-nums">{shown.length} fabrics</span>
      </div>

      <div className="grid grid-cols-3 gap-2.5" data-testid="fabric-grid">
        {filter !== "patterned" && (
          <Tile label="Original" caption="As shown" ariaLabel="Original" shape="swatch" selected={targets.every((id) => !spec.parts[id])} onClick={() => apply(null)}>
            <span className="absolute inset-0 bg-[repeating-linear-gradient(45deg,#e8e8e5_0_6px,#f7f7f5_6px_12px)]" />
          </Tile>
        )}
        {shown.map((fabric) => (
          <Tile
            key={fabric.key}
            label={fabric.colorName}
            caption={fabric.pattern ? (PATTERNS.find((p) => p.id === fabric.pattern?.id)?.label ?? "Pattern") : "Plain"}
            price={fabric.pattern ? patternPrice : undefined}
            ariaLabel={fabric.name}
            shape="swatch"
            selected={targets.length > 0 && targets.every((id) => samePart(spec.parts[id], fabric))}
            onClick={() => apply({ color: fabric.color, pattern: fabric.pattern ?? undefined })}
          >
            <span className="absolute inset-0" style={swatchStyle(fabric)} />
          </Tile>
        ))}
      </div>

      <section className="flex flex-col gap-3 border-t pt-4" aria-labelledby="print-heading">
        <div className="flex items-baseline justify-between gap-2">
          <h3 id="print-heading" className="text-sm font-medium">
            All-over print
          </h3>
          <span className="text-xs text-muted-foreground">+{formatBDT(config.addOns.patternMinor)} per part</span>
        </div>
        <p className="text-xs text-muted-foreground">Repeat a motif or your own image across {target === ALL ? `the whole ${props.noun}` : "this part"}, like printed fabric.</p>
        <div className="grid grid-cols-5 gap-2" data-testid="print-grid">
          <Tile label="None" ariaLabel="No print" selected={prints.every((p) => p === null)} onClick={() => setPrint(null)}>
            <span className="text-xs text-muted-foreground">—</span>
          </Tile>
          {decorations.map((d) => {
            const color = samePrint?.kind === "decoration" ? samePrint.color : (config.allowedColors[0]?.hex.toLowerCase() ?? "#1b1b1b");
            return (
              <Tile
                key={d.id}
                label={d.label}
                ariaLabel={`${d.label} print`}
                selected={samePrint?.kind === "decoration" && samePrint.id === d.id}
                onClick={() => setPrint({ kind: "decoration", id: d.id, color, tileCm })}
              >
                <Image src={decorationDataUrl(decorationSvg(d.id, "#444444", 64))} alt="" width={28} height={28} unoptimized />
              </Tile>
            );
          })}
          <label
            className={cn(
              "flex aspect-square cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border p-1 text-center text-[0.7rem] hover:border-foreground/40",
              samePrint?.kind === "image" && "border-foreground ring-1 ring-foreground",
              props.uploadState && "pointer-events-none opacity-60",
            )}
          >
            {samePrint?.kind === "image" && props.uploadUrls[samePrint.assetKey] ? (
              <Image src={props.uploadUrls[samePrint.assetKey] ?? ""} alt="Your print image" width={36} height={36} unoptimized className="size-9 object-contain" />
            ) : (
              <ImagePlus className="size-5 text-muted-foreground" />
            )}
            {props.uploadState ?? "Your image"}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              aria-label="Upload an image to print all over"
              className="sr-only"
              onChange={async (e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.value = "";
                const asset = file ? await props.onUpload(file) : null;
                if (asset) setPrint({ kind: "image", assetKey: asset.key, tileCm });
              }}
            />
          </label>
        </div>
        {samePrint && (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span>
                Size: repeats every <span className="tabular-nums">{samePrint.tileCm} cm</span>
              </span>
              <input
                type="range"
                min={PRINT_TILE_CM.min}
                max={30}
                step={1}
                value={samePrint.tileCm}
                onChange={(e) => setPrint({ ...samePrint, tileCm: Number(e.target.value) })}
                aria-label="Print size in centimetres"
              />
            </label>
            {samePrint.kind === "decoration" && (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Print colour">
                {config.allowedColors.map((c) => (
                  <Swatch key={c.name} small label={`Print ${c.name}`} color={c.hex} selected={samePrint.color === c.hex.toLowerCase()} onClick={() => setPrint({ ...samePrint, color: c.hex.toLowerCase() })} />
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground">Clothing brand logos can&apos;t be used.</p>
          </div>
        )}
      </section>

      {patternColor && (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Pattern colour</span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Pattern color">
            {config.allowedColors.map((c) => (
              <Swatch
                key={c.name}
                small
                label={`Pattern ${c.name}`}
                color={c.hex}
                selected={patternColor === c.hex.toLowerCase()}
                onClick={() =>
                  props.onChangeParts((parts) => {
                    const next = { ...parts };
                    for (const id of targets) {
                      const part = next[id];
                      if (part?.pattern) next[id] = { ...part, pattern: { ...part.pattern, color: c.hex.toLowerCase() } };
                    }
                    return next;
                  })
                }
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
