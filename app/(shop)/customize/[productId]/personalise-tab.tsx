"use client";

import { ImagePlus, Sparkles, Type } from "lucide-react";
import Image from "next/image";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DECORATIONS, decorationSvg, type DecorationId } from "@/lib/catalog/decorations";
import { FONTS, type FontId } from "@/lib/catalog/fonts";
import { formatBDT } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { DesignLayer } from "@/types/design-spec";
import type { PlacementArea, TemplateConfig } from "@/types/template";

import { AccordionRow, Swatch, Tile } from "./editor-ui";
import { decorationDataUrl } from "./recolor";

// Personalise tab: where on the dress, then text, decorations and the customer's own image,
// plus the controls for whichever item is selected on the canvas.

type Row = "text" | "decorations" | "image";

export type UploadControls = {
  state: string | null;
  removeBackground: boolean;
  setRemoveBackground: (value: boolean) => void;
  onFile: (file: File) => void;
};

export function PersonaliseTab(props: {
  config: TemplateConfig;
  activeArea: PlacementArea | null;
  onArea: (area: PlacementArea) => void;
  selectedLayer: DesignLayer | null;
  onUpdateLayer: (id: string, patch: (layer: DesignLayer) => DesignLayer) => void;
  onMoveLayer: (id: string, direction: -1 | 1) => void;
  onDeleteLayer: (id: string) => void;
  onAddText: (content: string) => void;
  onAddDecoration: (id: DecorationId) => void;
  upload: UploadControls;
}) {
  const { config, activeArea, selectedLayer } = props;
  const [open, setOpen] = useState<Row | null>("text");
  const [newText, setNewText] = useState("");
  const toggle = (row: Row) => setOpen((r) => (r === row ? null : row));
  const fonts = FONTS.filter((f) => config.allowedFonts.includes(f.id));
  const decorations = DECORATIONS.filter((d) => config.allowedDecorations.includes(d.id));

  if (config.placementAreas.length === 0) {
    return <p className="text-sm text-muted-foreground">This dress has no print areas, so text and images can&apos;t be added.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {selectedLayer && (
        <section className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3 text-sm" data-testid="selected-layer">
          <h3 className="font-medium">Selected {selectedLayer.kind === "text" ? "text" : selectedLayer.kind === "image" ? "image" : "decoration"}</h3>
          {selectedLayer.kind === "text" && (
            <>
              <Input
                aria-label="Text"
                value={selectedLayer.text.content}
                maxLength={60}
                onChange={(e) => props.onUpdateLayer(selectedLayer.id, (l) => (l.kind === "text" ? { ...l, text: { ...l.text, content: e.target.value } } : l))}
              />
              <label className="flex items-center gap-2">
                Font
                <select
                  value={selectedLayer.text.fontId}
                  onChange={(e) => {
                    const fontId: FontId | undefined = FONTS.find((f) => f.id === e.target.value)?.id;
                    if (fontId) props.onUpdateLayer(selectedLayer.id, (l) => (l.kind === "text" ? { ...l, text: { ...l.text, fontId } } : l));
                  }}
                  className="h-8 rounded-lg border border-input bg-background px-2"
                >
                  {fonts.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          {(selectedLayer.kind === "text" || selectedLayer.kind === "decoration") && (
            <div className="flex flex-wrap gap-1" role="group" aria-label="Item color">
              {config.allowedColors.map((c) => (
                <Swatch
                  key={c.name}
                  small
                  label={c.name}
                  color={c.hex}
                  selected={(selectedLayer.kind === "text" ? selectedLayer.text.color : selectedLayer.decoration.color) === c.hex.toLowerCase()}
                  onClick={() =>
                    props.onUpdateLayer(selectedLayer.id, (l) =>
                      l.kind === "text"
                        ? { ...l, text: { ...l.text, color: c.hex.toLowerCase() } }
                        : l.kind === "decoration"
                          ? { ...l, decoration: { ...l.decoration, color: c.hex.toLowerCase() } }
                          : l,
                    )
                  }
                />
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => props.onMoveLayer(selectedLayer.id, 1)}>
              Bring forward
            </Button>
            <Button size="sm" variant="outline" onClick={() => props.onMoveLayer(selectedLayer.id, -1)}>
              Send backward
            </Button>
            <Button size="sm" variant="destructive" onClick={() => props.onDeleteLayer(selectedLayer.id)}>
              Delete
            </Button>
          </div>
        </section>
      )}

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Where on the dress</span>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Print area">
          {config.placementAreas.map((area) => (
            <button
              key={area.id}
              type="button"
              aria-pressed={activeArea?.id === area.id}
              onClick={() => props.onArea(area)}
              className={cn("flex h-auto flex-col items-start rounded-lg border px-3 py-1.5 text-left text-sm", activeArea?.id === area.id ? "border-foreground bg-foreground text-background" : "hover:bg-muted")}
            >
              <span>{area.label}</span>
              <span className="text-xs opacity-70">
                {area.side === "back" ? "Back · " : ""}
                {area.widthCm}×{area.heightCm} cm
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col">
        {fonts.length > 0 && (
          <AccordionRow id="add-text" title="Text" value={`+${formatBDT(config.addOns.textMinor)}`} icon={<Type className="size-5" />} open={open === "text"} onToggle={() => toggle("text")}>
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!newText.trim()) return;
                props.onAddText(newText.trim());
                setNewText("");
              }}
            >
              <Input value={newText} maxLength={60} placeholder="Your name, initials or a word" aria-label="New text" onChange={(e) => setNewText(e.target.value)} className="h-9 min-w-0 flex-1" />
              <Button type="submit" variant="outline" disabled={!newText.trim() || !activeArea}>
                Add text (+{formatBDT(config.addOns.textMinor)})
              </Button>
            </form>
            <p className="mt-2 text-xs text-muted-foreground">Pick the font and colour after adding it.</p>
          </AccordionRow>
        )}

        {decorations.length > 0 && (
          <AccordionRow
            id="add-decoration"
            title="Decorations"
            value={`+${formatBDT(config.addOns.decorationMinor)} each`}
            icon={<Sparkles className="size-5" />}
            open={open === "decorations"}
            onToggle={() => toggle("decorations")}
          >
            <div className="grid grid-cols-4 gap-2">
              {decorations.map((d) => (
                <Tile key={d.id} label={d.label} ariaLabel={`Add ${d.label}`} onClick={() => props.onAddDecoration(d.id)}>
                  <DecorationIcon id={d.id} />
                </Tile>
              ))}
            </div>
          </AccordionRow>
        )}

        <AccordionRow id="add-image" title="Your image or logo" value={`+${formatBDT(config.addOns.imageMinor)}`} icon={<ImagePlus className="size-5" />} open={open === "image"} onToggle={() => toggle("image")}>
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <label className={cn("inline-flex h-9 cursor-pointer items-center rounded-lg border px-3 hover:bg-muted", (props.upload.state || !activeArea) && "pointer-events-none opacity-60")}>
                {props.upload.state ?? "Upload image"}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="sr-only"
                  onChange={(e) => {
                    const file = e.currentTarget.files?.[0];
                    e.currentTarget.value = "";
                    if (file) props.upload.onFile(file);
                  }}
                />
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" className="size-4" checked={props.upload.removeBackground} onChange={(e) => props.upload.setRemoveBackground(e.target.checked)} />
                Remove background
              </label>
            </div>
            <p className="text-xs text-muted-foreground">JPEG, PNG or WebP up to 4 MB. Clothing brand logos can&apos;t be used.</p>
          </div>
        </AccordionRow>
      </div>
    </div>
  );
}

function DecorationIcon({ id }: { id: DecorationId }) {
  // Curated, code-defined SVG rendered as an image (never injected as HTML).
  return <Image src={decorationDataUrl(decorationSvg(id, "#444444", 64))} alt="" width={32} height={32} unoptimized />;
}
