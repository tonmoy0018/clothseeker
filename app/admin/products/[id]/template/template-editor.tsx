"use client";

import Image from "next/image";
import { useEffect, useState, useTransition, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DECORATIONS } from "@/lib/catalog/decorations";
import { FONTS } from "@/lib/catalog/fonts";
import { PATTERNS } from "@/lib/catalog/patterns";
import { MINOR_PER_MAJOR } from "@/lib/money";
import { uniqueSlug } from "@/lib/text/slug";
import { cn } from "@/lib/utils";
import { STYLE_GROUPS, type StyleGroup, type TemplateConfig } from "@/types/template";

import { saveTemplateAction, setTemplateStateAction, uploadTemplateImageAction } from "./actions";
import { PlacementCanvas, type Rect } from "./placement-canvas";

const GROUP_LABEL: Record<StyleGroup, string> = {
  neckline: "Neckline",
  sleeveLength: "Sleeve length",
  dressLength: "Dress length",
};

const ADD_ON_LABEL: Record<keyof TemplateConfig["addOns"], string> = {
  textMinor: "Text layer",
  imageMinor: "Image / logo layer",
  patternMinor: "Pattern on a part",
  decorationMinor: "Decoration",
};

const toTaka = (minor: number) => minor / MINOR_PER_MAJOR;
const toMinor = (taka: string) => {
  const value = Number(taka);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * MINOR_PER_MAJOR) : 0;
};

type Message = { kind: "error" | "ok"; text: string; details?: string[] } | null;

type TemplateEditorProps = {
  productId: string;
  initialVersion: number;
  initialActive: boolean;
  initialAiEnabled: boolean;
  initialConfig: TemplateConfig;
  initialImageUrls: Record<string, string>;
};

export function TemplateEditor(props: TemplateEditorProps) {
  const { productId } = props;
  const [config, setConfig] = useState<TemplateConfig>(props.initialConfig);
  const [version, setVersion] = useState(props.initialVersion);
  const [isActive, setIsActive] = useState(props.initialActive);
  const [aiEnabled, setAiEnabled] = useState(props.initialAiEnabled);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>(props.initialImageUrls);
  const [dirty, setDirty] = useState(false);
  const [side, setSide] = useState<"front" | "back">("front");
  const [selectedArea, setSelectedArea] = useState<string | null>(props.initialConfig.placementAreas[0]?.id ?? null);
  const [message, setMessage] = useState<Message>(null);
  const [saving, startSaving] = useTransition();

  useEffect(() => {
    if (!dirty) {
      return;
    }
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function update(change: (draft: TemplateConfig) => TemplateConfig) {
    setConfig((current) => change(current));
    setDirty(true);
    setMessage(null);
  }

  function save() {
    startSaving(async () => {
      const result = await saveTemplateAction(productId, version, config);
      if (result.ok) {
        setVersion(result.version);
        setDirty(false);
        setMessage({ kind: "ok", text: `Saved as version ${result.version}.` });
      } else {
        const details = Object.entries(result.fieldErrors ?? {})
          .slice(0, 6)
          .map(([path, text]) => `${humanPath(path, config)}: ${text}`);
        setMessage({ kind: "error", text: result.error, details });
      }
    });
  }

  function saveState(nextActive: boolean, nextAi: boolean) {
    if (dirty) {
      setMessage({ kind: "error", text: "Save your changes first, then change the live status." });
      return;
    }
    startSaving(async () => {
      const result = await setTemplateStateAction(productId, nextActive, nextAi);
      if (result.error) {
        setMessage({ kind: "error", text: result.error });
      } else {
        setIsActive(nextActive);
        setAiEnabled(nextAi);
        setMessage({ kind: "ok", text: result.ok ?? "Updated." });
      }
    });
  }

  async function upload(slot: string, file: File): Promise<string | null> {
    if (file.size > 4 * 1024 * 1024) {
      setMessage({ kind: "error", text: "That file is larger than 4 MB." });
      return null;
    }
    const formData = new FormData();
    formData.set("productId", productId);
    formData.set("slot", slot);
    formData.set("image", file);
    const result = await uploadTemplateImageAction(formData);
    if (result.error !== undefined) {
      setMessage({ kind: "error", text: result.error });
      return null;
    }
    if (result.url) {
      const { key, url } = result;
      setImageUrls((urls) => ({ ...urls, [key]: url }));
    }
    setMessage({ kind: "ok", text: "Image uploaded. Save the template to keep it." });
    return result.key;
  }

  const areasOnSide = config.placementAreas.filter((a) => a.side === side);
  const garmentKey = config.garmentImages[side];
  const selected = config.placementAreas.find((a) => a.id === selectedArea) ?? null;
  const allIds = [...config.regions.map((r) => r.id), ...config.placementAreas.map((a) => a.id)];

  return (
    <div className="flex flex-col gap-6">
      {/* Sticky save bar */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-xl border bg-background/95 p-3 shadow-sm backdrop-blur">
        <span className="text-sm">
          Version {version} · {isActive ? <strong>Live</strong> : "Not live"}
          {dirty && <span className="ml-2 text-amber-700 dark:text-amber-400">Unsaved changes</span>}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4" checked={aiEnabled} disabled={saving} onChange={(e) => saveState(isActive, e.target.checked)} />
            AI design
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4" checked={isActive} disabled={saving} onChange={(e) => saveState(e.target.checked, aiEnabled)} />
            Live for customers
          </label>
          <Button onClick={save} disabled={saving || !dirty}>
            {saving ? "Saving…" : "Save template"}
          </Button>
        </div>
        {message && (
          <div role={message.kind === "error" ? "alert" : "status"} className={cn("w-full text-sm", message.kind === "error" ? "text-destructive" : "text-emerald-700 dark:text-emerald-400")}>
            {message.text}
            {message.details && message.details.length > 0 && (
              <ul className="mt-1 list-disc pl-5">
                {message.details.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <Section title="Garment images" description="Plain front and back photos or drawings of the dress, at least 800×800 px. Customers design on top of these.">
        <div className="grid gap-6 sm:grid-cols-2">
          {(["front", "back"] as const).map((s) => {
            const key = config.garmentImages[s];
            const url = key ? imageUrls[key] : undefined;
            return (
              <div key={s} className="flex flex-col gap-2">
                <span className="text-sm font-medium capitalize">{s}</span>
                <div className="relative aspect-[1200/1560] w-40 overflow-hidden rounded-lg border bg-muted">
                  {url ? <Image src={url} alt={`${s} garment`} fill unoptimized className="object-contain" /> : <span className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">No image</span>}
                </div>
                <FileButton
                  label={key ? `Replace ${s} image` : `Upload ${s} image`}
                  onFile={async (file) => {
                    const newKey = await upload(s, file);
                    if (newKey) {
                      update((c) => ({ ...c, garmentImages: { ...c.garmentImages, [s]: newKey } }));
                    }
                  }}
                />
              </div>
            );
          })}
        </div>
        {config.styleVariants.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm" data-testid="style-pictures">
            <p className="max-w-prose text-muted-foreground">
              This dress also has {config.styleVariants.length} style pictures, so the customer&apos;s preview changes shape with the neckline, sleeves and
              length. They replace the images above whenever they match the customer&apos;s choices. If you upload your own garment images, remove them.
            </p>
            <Button size="sm" variant="outline" onClick={() => update((c) => ({ ...c, styleVariants: [] }))}>
              Remove style pictures
            </Button>
          </div>
        )}
      </Section>

      <Section title="Placement areas" description="Where customers may put text, images and decorations. Draw the area on the garment and enter its real printable size.">
        <div className="grid gap-6 lg:grid-cols-[auto_1fr]">
          <div className="flex flex-col gap-2">
            <div className="flex gap-1" role="group" aria-label="Garment side">
              {(["front", "back"] as const).map((s) => (
                <Button key={s} size="sm" variant={side === s ? "default" : "outline"} onClick={() => setSide(s)} className="capitalize">
                  {s}
                </Button>
              ))}
            </div>
            <PlacementCanvas
              imageUrl={garmentKey ? (imageUrls[garmentKey] ?? null) : null}
              areas={areasOnSide}
              selectedId={selected?.side === side ? selected.id : null}
              onSelect={setSelectedArea}
              onChange={(id, rect: Rect) =>
                update((c) => ({ ...c, placementAreas: c.placementAreas.map((a) => (a.id === id ? { ...a, rect } : a)) }))
              }
            />
            <p className="max-w-sm text-xs text-muted-foreground">Select an area, then drag on the image to draw it, or drag inside it to move it.</p>
          </div>

          <div className="flex flex-col gap-3">
            {config.placementAreas.map((area, index) => (
              <div
                key={area.id}
                className={cn("grid grid-cols-2 gap-2 rounded-lg border p-3 text-sm sm:grid-cols-4", area.id === selectedArea && "border-blue-600")}
                onFocusCapture={() => {
                  setSelectedArea(area.id);
                  setSide(area.side);
                }}
              >
                <LabeledInput label="Label" className="col-span-2" value={area.label} onChange={(v) => update((c) => withArea(c, index, { label: v }))} />
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">Side</span>
                  <select
                    value={area.side}
                    onChange={(e) => update((c) => withArea(c, index, { side: e.target.value === "back" ? "back" : "front" }))}
                    className="h-8 rounded-lg border border-input bg-transparent px-2"
                  >
                    <option value="front">Front</option>
                    <option value="back">Back</option>
                  </select>
                </label>
                <div className="flex items-end justify-end">
                  <Button size="sm" variant="ghost" onClick={() => update((c) => ({ ...c, placementAreas: c.placementAreas.filter((_, i) => i !== index) }))}>
                    Remove
                  </Button>
                </div>
                <LabeledNumber label="Width (cm)" value={area.widthCm} step={0.5} onChange={(v) => update((c) => withArea(c, index, { widthCm: v }))} />
                <LabeledNumber label="Height (cm)" value={area.heightCm} step={0.5} onChange={(v) => update((c) => withArea(c, index, { heightCm: v }))} />
                <LabeledNumber label="Left %" value={pct(area.rect.x)} step={0.5} onChange={(v) => update((c) => withArea(c, index, { rect: { ...area.rect, x: v / 100 } }))} />
                <LabeledNumber label="Top %" value={pct(area.rect.y)} step={0.5} onChange={(v) => update((c) => withArea(c, index, { rect: { ...area.rect, y: v / 100 } }))} />
                <LabeledNumber label="Width %" value={pct(area.rect.w)} step={0.5} onChange={(v) => update((c) => withArea(c, index, { rect: { ...area.rect, w: v / 100 } }))} />
                <LabeledNumber label="Height %" value={pct(area.rect.h)} step={0.5} onChange={(v) => update((c) => withArea(c, index, { rect: { ...area.rect, h: v / 100 } }))} />
              </div>
            ))}
            {config.placementAreas.length < 8 && (
              <Button
                variant="outline"
                className="self-start"
                onClick={() => {
                  const id = uniqueSlug(`${side}-area`, allIds);
                  update((c) => ({
                    ...c,
                    placementAreas: [...c.placementAreas, { id, label: "New area", side, rect: { x: 0.35, y: 0.3, w: 0.3, h: 0.15 }, widthCm: 20, heightCm: 10 }],
                  }));
                  setSelectedArea(id);
                }}
              >
                Add area on {side}
              </Button>
            )}
          </div>
        </div>
      </Section>

      <Section
        title="Recolorable regions"
        description="Parts of the dress customers can color or pattern separately. Each needs a mask: a black image the same size as the garment image, painted white where the region is."
      >
        <div className="flex flex-col gap-2">
          {config.regions.map((region, index) => (
            <div key={region.id} className="flex flex-wrap items-end gap-3 text-sm">
              <LabeledInput label="Label" value={region.label} onChange={(v) => update((c) => ({ ...c, regions: c.regions.map((r, i) => (i === index ? { ...r, label: v } : r)) }))} />
              <span className="pb-2 text-xs text-muted-foreground">id: {region.id}</span>
              <label className="flex items-center gap-2 pb-2">
                <input type="checkbox" className="size-4" checked={region.recolorable} onChange={(e) => update((c) => ({ ...c, regions: c.regions.map((r, i) => (i === index ? { ...r, recolorable: e.target.checked } : r)) }))} />
                Recolorable
              </label>
              <Button size="sm" variant="ghost" disabled={config.regions.length <= 1} onClick={() => update((c) => ({ ...c, regions: c.regions.filter((_, i) => i !== index) }))}>
                Remove
              </Button>
              <div className="flex w-full flex-wrap items-center gap-3 pb-2">
                {(["front", "back"] as const).map((maskSide) => {
                  const maskKey = region.masks[maskSide];
                  const maskUrl = maskKey ? imageUrls[maskKey] : undefined;
                  return (
                    <div key={maskSide} className="flex items-center gap-2">
                      {maskUrl ? (
                        <span className="relative h-12 w-9 overflow-hidden rounded border bg-black">
                          <Image src={maskUrl} alt={`${region.label} ${maskSide} mask`} fill unoptimized className="object-contain" />
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">No {maskSide} mask</span>
                      )}
                      <FileButton
                        size="xs"
                        label={maskKey ? `Replace ${maskSide} mask` : `Upload ${maskSide} mask`}
                        onFile={async (file) => {
                          const key = await upload(`mask:${maskSide}:${region.id}`, file);
                          if (key) {
                            update((c) => ({
                              ...c,
                              regions: c.regions.map((r, i) => (i === index ? { ...r, masks: { ...r.masks, [maskSide]: key } } : r)),
                            }));
                          }
                        }}
                      />
                      {maskKey && (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            update((c) => ({
                              ...c,
                              regions: c.regions.map((r, i) => (i === index ? { ...r, masks: { ...r.masks, [maskSide]: undefined } } : r)),
                            }))
                          }
                        >
                          Clear
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {config.regions.length < 12 && (
            <AddByName
              placeholder="e.g. Waistband"
              buttonLabel="Add region"
              onAdd={(name) => update((c) => ({ ...c, regions: [...c.regions, { id: uniqueSlug(name, allIds), label: name, recolorable: true, masks: {} }] }))}
            />
          )}
        </div>
      </Section>

      <Section title="Style options" description="One choice per group. Add-on prices are added to the base price. A reference image helps customers see the option.">
        <div className="grid gap-6 lg:grid-cols-3">
          {STYLE_GROUPS.map((group) => (
            <div key={group} className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold">{GROUP_LABEL[group]}</h3>
              {config.styleOptions[group].map((option, index) => {
                const refUrl = option.referenceImageKey ? imageUrls[option.referenceImageKey] : undefined;
                return (
                  <div key={option.id} className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
                    <div className="flex items-end gap-2">
                      <LabeledInput label="Label" value={option.label} onChange={(v) => update((c) => withOption(c, group, index, { label: v }))} />
                      <LabeledNumber label="Add-on ৳" className="w-24 shrink-0" value={toTaka(option.addOnPriceMinor)} step={50} onChange={(v) => update((c) => withOption(c, group, index, { addOnPriceMinor: Math.round(v * MINOR_PER_MAJOR) }))} />
                    </div>
                    <div className="flex items-center gap-2">
                      {refUrl && (
                        <span className="relative size-12 overflow-hidden rounded bg-muted">
                          <Image src={refUrl} alt={`${option.label} reference`} fill unoptimized className="object-cover" />
                        </span>
                      )}
                      <FileButton
                        size="xs"
                        label={option.referenceImageKey ? "Replace image" : "Add reference image"}
                        onFile={async (file) => {
                          const key = await upload(`style:${group}:${option.id}`, file);
                          if (key) {
                            update((c) => withOption(c, group, index, { referenceImageKey: key }));
                          }
                        }}
                      />
                      <Button size="xs" variant="ghost" className="ml-auto" disabled={config.styleOptions[group].length <= 1} onClick={() => update((c) => ({ ...c, styleOptions: { ...c.styleOptions, [group]: c.styleOptions[group].filter((_, i) => i !== index) } }))}>
                        Remove
                      </Button>
                    </div>
                  </div>
                );
              })}
              {config.styleOptions[group].length < 8 && (
                <AddByName
                  placeholder="New option"
                  buttonLabel="Add"
                  onAdd={(name) =>
                    update((c) => ({
                      ...c,
                      styleOptions: {
                        ...c.styleOptions,
                        [group]: [...c.styleOptions[group], { id: uniqueSlug(name, c.styleOptions[group].map((o) => o.id)), label: name, addOnPriceMinor: 0 }],
                      },
                    }))
                  }
                />
              )}
            </div>
          ))}
        </div>
      </Section>

      <Section title="Allowed colors" description="Colors customers can choose for recolorable regions.">
        <div className="flex flex-wrap gap-3">
          {config.allowedColors.map((color, index) => (
            <div key={`${color.name}-${index}`} className="flex items-center gap-2 rounded-lg border p-2 text-sm">
              <input
                type="color"
                aria-label={`${color.name} color`}
                value={color.hex.toLowerCase()}
                onChange={(e) => update((c) => ({ ...c, allowedColors: c.allowedColors.map((col, i) => (i === index ? { ...col, hex: e.target.value } : col)) }))}
                className="h-7 w-9 rounded border"
              />
              <Input
                aria-label="Color name"
                value={color.name}
                maxLength={30}
                onChange={(e) => update((c) => ({ ...c, allowedColors: c.allowedColors.map((col, i) => (i === index ? { ...col, name: e.target.value } : col)) }))}
                className="h-7 w-28"
              />
              <Button size="xs" variant="ghost" disabled={config.allowedColors.length <= 1} onClick={() => update((c) => ({ ...c, allowedColors: c.allowedColors.filter((_, i) => i !== index) }))} aria-label={`Remove ${color.name}`}>
                ✕
              </Button>
            </div>
          ))}
        </div>
        {config.allowedColors.length < 40 && (
          <AddByName placeholder="Color name" buttonLabel="Add color" onAdd={(name) => update((c) => ({ ...c, allowedColors: [...c.allowedColors, { name, hex: "#888888" }] }))} />
        )}
      </Section>

      <div className="grid gap-6 md:grid-cols-2">
        <Section title="Patterns" description="Patterns customers may apply to a region.">
          <CheckboxList
            options={PATTERNS.map((p) => ({ id: p.id, label: p.label }))}
            checked={config.allowedPatterns}
            onChange={(ids) => update((c) => ({ ...c, allowedPatterns: PATTERNS.map((p) => p.id).filter((id) => ids.includes(id)) }))}
          />
        </Section>
        <Section title="Decorations" description="Decorations customers may place in placement areas.">
          <CheckboxList
            options={DECORATIONS.map((d) => ({ id: d.id, label: d.label }))}
            checked={config.allowedDecorations}
            onChange={(ids) => update((c) => ({ ...c, allowedDecorations: DECORATIONS.map((d) => d.id).filter((id) => ids.includes(id)) }))}
          />
        </Section>
        <Section title="Fonts" description="Fonts available for text layers.">
          <CheckboxList
            options={FONTS.map((f) => ({ id: f.id, label: `${f.label} — ${f.style}` }))}
            checked={config.allowedFonts}
            onChange={(ids) => update((c) => ({ ...c, allowedFonts: FONTS.map((f) => f.id).filter((id) => ids.includes(id)) }))}
          />
        </Section>
      </div>

      <Section title="Add-on prices" description="Charged once per layer or patterned part, on top of the dress and style-option prices.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(Object.keys(ADD_ON_LABEL) as (keyof TemplateConfig["addOns"])[]).map((key) => (
            <LabeledNumber key={key} label={`${ADD_ON_LABEL[key]} (৳)`} value={toTaka(config.addOns[key])} step={50} onChange={(v) => update((c) => ({ ...c, addOns: { ...c.addOns, [key]: toMinor(String(v)) } }))} />
          ))}
        </div>
      </Section>
    </div>
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────────

const pct = (fraction: number) => Math.round(fraction * 1000) / 10;

function withArea(config: TemplateConfig, index: number, patch: Partial<TemplateConfig["placementAreas"][number]>): TemplateConfig {
  return { ...config, placementAreas: config.placementAreas.map((a, i) => (i === index ? { ...a, ...patch } : a)) };
}

function withOption(
  config: TemplateConfig,
  group: StyleGroup,
  index: number,
  patch: Partial<TemplateConfig["styleOptions"][StyleGroup][number]>,
): TemplateConfig {
  return {
    ...config,
    styleOptions: { ...config.styleOptions, [group]: config.styleOptions[group].map((o, i) => (i === index ? { ...o, ...patch } : o)) },
  };
}

/** "config.placementAreas.1.rect" → "Placement area “Front skirt”". */
function humanPath(path: string, config: TemplateConfig): string {
  const parts = path.replace(/^config\./, "").split(".");
  const [section, index] = parts;
  if (section === "placementAreas" && index !== undefined) {
    return `Placement area “${config.placementAreas[Number(index)]?.label ?? index}”`;
  }
  if (section === "regions" && index !== undefined) {
    return `Region “${config.regions[Number(index)]?.label ?? index}”`;
  }
  if (section === "styleOptions" && index !== undefined) {
    const group = STYLE_GROUPS.find((g) => g === index);
    return `${group ? GROUP_LABEL[group] : index} options`;
  }
  return section ?? path;
}

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  );
}

function LabeledInput({ label, value, onChange, className }: { label: string; value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <label className={cn("flex min-w-0 flex-1 flex-col gap-1", className)}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <Input value={value} maxLength={40} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function LabeledNumber({
  label,
  value,
  onChange,
  step,
  className = "w-full",
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step: number;
  className?: string;
}) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <Input type="number" step={step} min={0} value={value} onChange={(e) => onChange(Number(e.target.value) || 0)} />
    </label>
  );
}

function AddByName({ placeholder, buttonLabel, onAdd }: { placeholder: string; buttonLabel: string; onAdd: (name: string) => void }) {
  const [name, setName] = useState("");
  const submit = () => {
    const trimmed = name.trim();
    if (trimmed) {
      onAdd(trimmed.slice(0, 40));
      setName("");
    }
  };
  return (
    <div className="flex items-center gap-2">
      <Input
        value={name}
        placeholder={placeholder}
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        className="h-8 w-44"
      />
      <Button size="sm" variant="outline" onClick={submit} disabled={!name.trim()}>
        {buttonLabel}
      </Button>
    </div>
  );
}

function CheckboxList({ options, checked, onChange }: { options: { id: string; label: string }[]; checked: readonly string[]; onChange: (ids: string[]) => void }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      {options.map((o) => (
        <label key={o.id} className="flex items-center gap-2">
          <input
            type="checkbox"
            className="size-4"
            checked={checked.includes(o.id)}
            onChange={(e) => onChange(e.target.checked ? [...checked, o.id] : checked.filter((id) => id !== o.id))}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

function FileButton({ label, onFile, size = "sm" }: { label: string; onFile: (file: File) => Promise<void>; size?: "sm" | "xs" }) {
  const [busy, setBusy] = useState(false);
  return (
    <label className={cn("inline-flex w-fit cursor-pointer items-center rounded-lg border px-2.5 text-sm hover:bg-muted", size === "xs" ? "h-6 text-xs" : "h-8", busy && "pointer-events-none opacity-60")}>
      {busy ? "Uploading…" : label}
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        onChange={async (e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (file) {
            setBusy(true);
            try {
              await onFile(file);
            } finally {
              setBusy(false);
            }
          }
        }}
      />
    </label>
  );
}
