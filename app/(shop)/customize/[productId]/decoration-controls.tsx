"use client";

import { Button } from "@/components/ui/button";
import { borderBox, borderSpacing, hasDetail, OUTLINE_WIDTH, REPEAT_COUNT } from "@/lib/catalog/decorations";
import { formatBDT } from "@/lib/money";
import type { DesignLayer } from "@/types/design-spec";
import type { TemplateConfig } from "@/types/template";

import { Swatch } from "./editor-ui";

// Controls for a selected decoration beyond its main colour: a second colour for the shape's detail,
// filled or outline, mirror, and repeating it as a border (count, spacing, curve). The box is resized
// with `borderBox` so it keeps its centre and stays inside its print area; the server re-checks all of it.

type DecorationLayer = Extract<DesignLayer, { kind: "decoration" }>;
type Decoration = DecorationLayer["decoration"];

const NEW_BORDER = { count: 6, spacing: 0.3, curve: 0 } as const;

export function DecorationControls({
  layer,
  config,
  onUpdate,
}: {
  layer: DecorationLayer;
  config: TemplateConfig;
  onUpdate: (patch: (layer: DecorationLayer) => DecorationLayer) => void;
}) {
  const d = layer.decoration;
  const area = config.placementAreas.find((a) => a.id === layer.areaId);
  const areaCm = area ? { width: area.widthCm, height: area.heightCm } : { width: 1, height: 1 };
  // An area trimmed to the fabric is wider than the garment: keep borders to its middle, on the fabric.
  const maxShare = area?.clipToFabric ? 0.6 : 1;
  const box = { x: layer.x, y: layer.y, w: layer.w, h: layer.h };
  const set = (change: Partial<Decoration>, nextBox?: typeof box) =>
    onUpdate((l) => ({ ...l, ...(nextBox ?? {}), decoration: dropUnset({ ...l.decoration, ...change }) }));
  const spacing = d.repeat ? borderSpacing(box, areaCm, d.repeat.count, d.repeat.curve) : NEW_BORDER.spacing;

  return (
    <div className="flex flex-col gap-3" data-testid="decoration-controls">
      {hasDetail(d.id) && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Second color (the detail)</span>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Second color">
            <Swatch small label="Same as main" selected={d.detail === undefined} onClick={() => set({ detail: undefined })} />
            {config.allowedColors.map((c) => (
              <Swatch key={c.name} small label={c.name} color={c.hex} selected={d.detail === c.hex.toLowerCase()} onClick={() => set({ detail: c.hex.toLowerCase() })} />
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Decoration style">
        {(["filled", "outline"] as const).map((style) => (
          <Button key={style} size="sm" variant={(d.style ?? "filled") === style ? "default" : "outline"} aria-pressed={(d.style ?? "filled") === style} onClick={() => set({ style: style === "filled" ? undefined : style })}>
            {style === "filled" ? "Filled" : "Outline"}
          </Button>
        ))}
        <Button size="sm" variant={d.mirror ? "default" : "outline"} aria-pressed={!!d.mirror} onClick={() => set({ mirror: d.mirror ? undefined : true })}>
          Mirror
        </Button>
      </div>
      {d.style === "outline" && (
        <label className="flex items-center gap-2 text-xs">
          Outline thickness
          <input
            type="range"
            min={OUTLINE_WIDTH.min}
            max={OUTLINE_WIDTH.max}
            value={d.outline ?? OUTLINE_WIDTH.default}
            onChange={(e) => set({ outline: Number(e.target.value) })}
            aria-label="Outline thickness"
          />
        </label>
      )}

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          className="size-4"
          checked={!!d.repeat}
          onChange={(e) =>
            e.target.checked
              ? set({ repeat: { count: NEW_BORDER.count, curve: NEW_BORDER.curve } }, borderBox(box, areaCm, NEW_BORDER.count, NEW_BORDER.spacing, NEW_BORDER.curve, NEW_BORDER.curve, maxShare))
              : set({ repeat: undefined }, borderBox(box, areaCm, 1, 0, 0, d.repeat?.curve ?? 0))
          }
        />
        Repeat as a border
      </label>
      {d.repeat && (
        <div className="flex flex-col gap-2 text-xs" data-testid="border-controls">
          <label className="flex items-center justify-between gap-2">
            <span>How many: {d.repeat.count}</span>
            <input
              type="range"
              min={REPEAT_COUNT.min}
              max={REPEAT_COUNT.max}
              value={d.repeat.count}
              aria-label="How many"
              onChange={(e) => {
                const count = Number(e.target.value);
                const curve = d.repeat?.curve ?? 0;
                set({ repeat: { count, curve } }, borderBox(box, areaCm, count, spacing, curve, curve, maxShare));
              }}
            />
          </label>
          <label className="flex items-center justify-between gap-2">
            <span>Spacing</span>
            <input
              type="range"
              min={0}
              max={150}
              value={Math.round(spacing * 100)}
              aria-label="Spacing"
              onChange={(e) => {
                const repeat = d.repeat ?? NEW_BORDER;
                set({}, borderBox(box, areaCm, repeat.count, Number(e.target.value) / 100, repeat.curve, repeat.curve, maxShare));
              }}
            />
          </label>
          <label className="flex items-center justify-between gap-2">
            <span>Curve (arch ↔ U)</span>
            <input
              type="range"
              min={-100}
              max={100}
              value={Math.round(d.repeat.curve * 100)}
              aria-label="Curve"
              onChange={(e) => {
                const curve = Number(e.target.value) / 100;
                const count = d.repeat?.count ?? NEW_BORDER.count;
                set({ repeat: { count, curve } }, borderBox(box, areaCm, count, spacing, curve, d.repeat?.curve ?? 0, maxShare));
              }}
            />
          </label>
          <p className="text-muted-foreground">Each motif in a border is made like one decoration ({formatBDT(config.addOns.decorationMinor)} each).</p>
        </div>
      )}
    </div>
  );
}

/** Removes settings that were switched back to their default, so plain decorations stay plain. */
function dropUnset(decoration: Decoration): Decoration {
  const { detail, style, outline, mirror, repeat, ...rest } = decoration;
  return {
    ...rest,
    ...(detail !== undefined ? { detail } : {}),
    ...(style === "outline" ? { style, ...(outline !== undefined ? { outline } : {}) } : {}),
    ...(mirror ? { mirror } : {}),
    ...(repeat ? { repeat } : {}),
  };
}
