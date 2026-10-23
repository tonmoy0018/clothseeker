"use client";

import { useMemo, useState } from "react";

import { PATTERNS, patternSvg, type PatternId } from "@/lib/catalog/patterns";
import { formatBDT } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { DesignSpec } from "@/types/design-spec";
import type { TemplateConfig } from "@/types/template";

import { Swatch, Tile } from "./editor-ui";

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

  const apply = (part: Part | null) =>
    props.onChangeParts((parts) => {
      const next = { ...parts };
      for (const id of targets) {
        if (part) next[id] = part;
        else delete next[id];
      }
      return next;
    });

  // Fine-tune the print colour once every chosen part has the same pattern.
  const patternIds = new Set(targets.map((id) => spec.parts[id]?.pattern?.id ?? null));
  const patternColor = targets.length > 0 && patternIds.size === 1 && !patternIds.has(null) ? (spec.parts[targets[0] ?? ""]?.pattern?.color ?? null) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Part to color">
        {[{ id: ALL, label: "Whole dress" }, ...regions].map((r) => (
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
