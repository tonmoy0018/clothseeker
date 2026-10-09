"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DECORATIONS, decorationSvg, type DecorationId } from "@/lib/catalog/decorations";
import { FONTS, fontUrl, type FontId } from "@/lib/catalog/fonts";
import { PATTERNS, type PatternId } from "@/lib/catalog/patterns";
import { priceDesign, type DesignPrice } from "@/lib/design/pricing";
import { validateDesignAgainstTemplate, type DesignIssue } from "@/lib/design/validate";
import type { Size } from "@/lib/generated/prisma/enums";
import { formatBDT } from "@/lib/money";
import { cn } from "@/lib/utils";
import { designSpecSchema, type DesignLayer, type DesignSpec } from "@/types/design-spec";
import { STYLE_GROUPS, type StyleGroup, type TemplateConfig } from "@/types/template";

import { addDesignToCartAction, saveDesignAction, uploadDesignImageAction, type DesignActionResult } from "./actions";
import { TryOnPanel } from "../../try-on-panel";

import { AiBox } from "./ai-box";
import { QuoteRequest } from "./quote-request";
import { DesignCanvas, type LayerBox } from "./design-canvas";
import { composeGarment, decorationDataUrl, loadImage, type ClientFill } from "./recolor";

const GROUP_LABEL: Record<StyleGroup, string> = { neckline: "Neckline", sleeveLength: "Sleeve length", dressLength: "Dress length" };
const HISTORY_LIMIT = 50;

export type DesignEditorProps = {
  productId: string;
  productName: string;
  templateId: string;
  templateVersion: number;
  aiEnabled: boolean;
  config: TemplateConfig;
  imageUrls: Record<string, string>;
  availableSizes: Size[];
  basePrices: Partial<Record<Size, number>>;
  /** Signed-in customer's id (for image ownership checks), or null. */
  customerId: string | null;
  initialDesign: { designId: string; spec: DesignSpec; uploadUrls: Record<string, string>; saved: boolean; referencePhotoUrl: string | null } | null;
  /** An AI round already queued for this design (after "start from a description"). */
  initialAiJobId?: string | null;
  /** Other good matches from a photo/description start. */
  alternatives?: { productId: string; name: string }[];
};

const draftKey = (productId: string) => `cs-design-draft-${productId}`;

function newLayerId(): string {
  return `l${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** An unsaved design kept while the customer signed in, if it belongs to this dress. */
function readDraft(p: DesignEditorProps): DesignSpec | null {
  try {
    const raw = window.sessionStorage.getItem(draftKey(p.productId));
    const draft = raw ? designSpecSchema.safeParse(JSON.parse(raw)) : null;
    if (draft?.success && draft.data.productId === p.productId) {
      return { ...draft.data, templateId: p.templateId, templateVersion: p.templateVersion };
    }
  } catch {
    // Storage unavailable (private mode) or bad JSON — start fresh.
  }
  return null;
}

function defaultSpec(p: DesignEditorProps): DesignSpec {
  return {
    version: 1,
    productId: p.productId,
    templateId: p.templateId,
    templateVersion: p.templateVersion,
    size: p.availableSizes[0] ?? "M",
    styleOptions: {
      neckline: p.config.styleOptions.neckline[0]?.id ?? "",
      sleeveLength: p.config.styleOptions.sleeveLength[0]?.id ?? "",
      dressLength: p.config.styleOptions.dressLength[0]?.id ?? "",
    },
    parts: {},
    layers: [],
    startedFrom: "shop",
  };
}

/**
 * A box of the given aspect (width/height, in cm) sized to `fraction` of the area's shorter side,
 * centred horizontally; `anchorY` places its centre vertically (0 = top, 1 = bottom).
 */
function centredBox(area: { widthCm: number; heightCm: number }, fraction: number, aspect = 1, anchorY = 0.5): LayerBox {
  const side = fraction * Math.min(area.widthCm, area.heightCm);
  const wCm = aspect >= 1 ? side : side * aspect;
  const hCm = aspect >= 1 ? side / aspect : side;
  const w = Math.min(wCm / area.widthCm, 1);
  const h = Math.min(hCm / area.heightCm, 1);
  const y = Math.min(Math.max(anchorY - h / 2, 0), 1 - h);
  return { x: (1 - w) / 2, y, w, h, rotation: 0 };
}

export function DesignEditor(props: DesignEditorProps) {
  const { config } = props;
  const router = useRouter();
  // Client-only component (loaded with ssr: false), so the initializer can read sessionStorage.
  const [restoredDraft] = useState(() => (props.initialDesign ? null : readDraft(props)));
  const [spec, setSpec] = useState<DesignSpec>(() => props.initialDesign?.spec ?? restoredDraft ?? defaultSpec(props));
  const [past, setPast] = useState<DesignSpec[]>([]);
  const [future, setFuture] = useState<DesignSpec[]>([]);
  const [designId, setDesignId] = useState<string | null>(props.initialDesign?.designId ?? null);
  // A hidden draft made by the AI box isn't "saved" until the customer presses Save.
  const [isDraft, setIsDraft] = useState(props.initialDesign ? !props.initialDesign.saved : false);
  const [uploadUrls, setUploadUrls] = useState<Record<string, string>>(props.initialDesign?.uploadUrls ?? {});
  const [side, setSide] = useState<"front" | "back">("front");
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [activeAreaId, setActiveAreaId] = useState<string | null>(config.placementAreas.find((a) => a.side === "front")?.id ?? null);
  const [garments, setGarments] = useState<{ front: HTMLCanvasElement | null; back: HTMLCanvasElement | null }>({ front: null, back: null });
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [serverIssues, setServerIssues] = useState<DesignIssue[]>([]);
  const [dirty, setDirty] = useState(restoredDraft !== null);
  const [fontsReady, setFontsReady] = useState(false);
  const [pending, startTransition] = useTransition();
  const [showTryOn, setShowTryOn] = useState(false);

  // ── fonts ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const allowed = FONTS.filter((f) => config.allowedFonts.includes(f.id));
    void Promise.all(allowed.map((f) => document.fonts.load(`32px "${f.family}"`))).finally(() => setFontsReady(true));
  }, [config.allowedFonts]);

  // The restored draft has been taken over by this editor; drop the stored copy.
  useEffect(() => {
    if (restoredDraft) {
      try {
        window.sessionStorage.removeItem(draftKey(props.productId));
      } catch {
        // Storage unavailable — nothing to clean up.
      }
    }
  }, [restoredDraft, props.productId]);

  useEffect(() => {
    if (!dirty) {
      return;
    }
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // ── recolored garment per side ─────────────────────────────────────────────
  const fillsBySide = useMemo(() => {
    const fills = (s: "front" | "back"): ClientFill[] =>
      config.regions.flatMap((region) => {
        const part = spec.parts[region.id];
        const maskKey = region.masks[s];
        const maskUrl = maskKey ? props.imageUrls[maskKey] : undefined;
        return part && maskUrl && region.recolorable ? [{ maskUrl, color: part.color, pattern: part.pattern ?? null }] : [];
      });
    return { front: fills("front"), back: fills("back") };
  }, [config.regions, spec.parts, props.imageUrls]);

  useEffect(() => {
    let cancelled = false;
    for (const s of ["front", "back"] as const) {
      const key = config.garmentImages[s];
      const url = key ? props.imageUrls[key] : undefined;
      if (!url) {
        continue;
      }
      void composeGarment(url, fillsBySide[s], 900)
        .then((canvas) => {
          if (!cancelled) {
            setGarments((g) => ({ ...g, [s]: canvas }));
          }
        })
        .catch(() => setMessage({ kind: "error", text: "The dress image couldn't load. Refresh the page to try again." }));
    }
    return () => {
      cancelled = true;
    };
  }, [fillsBySide, config.garmentImages, props.imageUrls]);

  // ── editing helpers ────────────────────────────────────────────────────────
  function commit(next: DesignSpec | ((current: DesignSpec) => DesignSpec)) {
    setSpec((current) => {
      const value = typeof next === "function" ? next(current) : next;
      setPast((p) => [...p.slice(-(HISTORY_LIMIT - 1)), current]);
      setFuture([]);
      return value;
    });
    setDirty(true);
    setMessage(null);
    setServerIssues([]);
  }

  function undo() {
    const previous = past.at(-1);
    if (!previous) return;
    setPast((p) => p.slice(0, -1));
    setFuture((f) => [spec, ...f]);
    setSpec(previous);
    setDirty(true);
  }

  function redo() {
    const next = future[0];
    if (!next) return;
    setFuture((f) => f.slice(1));
    setPast((p) => [...p, spec]);
    setSpec(next);
    setDirty(true);
  }

  const areasOnSide = config.placementAreas.filter((a) => a.side === side);
  const activeArea = config.placementAreas.find((a) => a.id === activeAreaId && a.side === side) ?? areasOnSide[0] ?? null;
  const layersOnSide = spec.layers.filter((l) => areasOnSide.some((a) => a.id === l.areaId));
  const selectedLayer = spec.layers.find((l) => l.id === selectedLayerId) ?? null;
  const allowedColors = config.allowedColors;
  const defaultColor = allowedColors[0]?.hex.toLowerCase() ?? "#1b1b1b";

  function addLayer(layer: DesignLayer) {
    commit((s) => ({ ...s, layers: [...s.layers, layer] }));
    setSelectedLayerId(layer.id);
  }

  function updateLayer(id: string, patch: (layer: DesignLayer) => DesignLayer) {
    commit((s) => ({ ...s, layers: s.layers.map((l) => (l.id === id ? patch(l) : l)) }));
  }

  function moveLayer(id: string, direction: -1 | 1) {
    commit((s) => {
      const index = s.layers.findIndex((l) => l.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= s.layers.length) return s;
      const layers = [...s.layers];
      const [item] = layers.splice(index, 1);
      if (item) layers.splice(target, 0, item);
      return { ...s, layers };
    });
  }

  // ── price & validation (client preview of the server's rules) ─────────────
  const base = props.basePrices[spec.size];
  const price: DesignPrice | null = useMemo(() => {
    try {
      return base === undefined ? null : priceDesign(spec, config, base);
    } catch {
      return null;
    }
  }, [spec, config, base]);

  const issues = useMemo(
    () =>
      validateDesignAgainstTemplate(spec, config, {
        productId: props.productId,
        templateId: props.templateId,
        availableSizes: props.availableSizes,
        customerId: props.customerId,
      }).filter((i) => !(props.customerId === null && i.path.endsWith(".image"))),
    [spec, config, props.productId, props.templateId, props.availableSizes, props.customerId],
  );

  // ── save / cart ────────────────────────────────────────────────────────────
  function handleResult(result: DesignActionResult, onOk: (designId: string) => void) {
    if (result.status === "signin") {
      try {
        window.sessionStorage.setItem(draftKey(props.productId), JSON.stringify(spec));
      } catch {
        // Can't keep the draft; the customer will start over after signing in.
      }
      setDirty(false);
      router.push(`/login?next=${encodeURIComponent(`/customize/${props.productId}`)}`);
      return;
    }
    if (result.status === "error") {
      setMessage({ kind: "error", text: result.message });
      setServerIssues(result.issues);
      return;
    }
    setDesignId(result.designId);
    setIsDraft(false);
    setDirty(false);
    onOk(result.designId);
  }

  function save() {
    startTransition(async () => {
      handleResult(await saveDesignAction(designId, spec), (id) => {
        setMessage({ kind: "ok", text: "Design saved. Find it any time in My designs." });
        router.replace(`/customize/${props.productId}?design=${id}`, { scroll: false });
      });
    });
  }

  function addToCart() {
    startTransition(async () => {
      handleResult(await addDesignToCartAction(designId, spec), () => router.push("/cart"));
    });
  }

  // ── image upload (+ optional background removal in the browser) ───────────
  const [removeBg, setRemoveBg] = useState(false);
  const [uploadState, setUploadState] = useState<string | null>(null);

  async function uploadImage(file: File) {
    if (!activeArea) return;
    if (file.size > 4 * 1024 * 1024) {
      setMessage({ kind: "error", text: "Images must be 4 MB or smaller." });
      return;
    }
    if (!props.customerId) {
      handleResult({ status: "signin" }, () => undefined);
      return;
    }
    try {
      let blob: Blob = file;
      if (removeBg) {
        setUploadState("Removing background… (first time downloads about 40 MB)");
        const { removeBackground } = await import("@imgly/background-removal");
        blob = await removeBackground(file, {
          progress: (_key, current, total) => setUploadState(`Removing background… ${total ? Math.round((current / total) * 100) : 0}%`),
        });
      }
      setUploadState("Uploading…");
      const form = new FormData();
      form.set("image", blob, "upload.png");
      const result = await uploadDesignImageAction(form);
      if (result.status === "signin") {
        handleResult(result, () => undefined);
        return;
      }
      if (result.status === "error") {
        setMessage({ kind: "error", text: result.message });
        return;
      }
      const url = result.url ?? "";
      const img = await loadImage(url);
      const aspectCm = img.naturalWidth / img.naturalHeight;
      setUploadUrls((u) => ({ ...u, [result.key]: url }));
      addLayer({ id: newLayerId(), areaId: activeArea.id, kind: "image", ...centredBox(activeArea, 0.6, aspectCm), image: { assetKey: result.key } });
    } catch {
      setMessage({ kind: "error", text: "That image couldn't be added. Try a different file." });
    } finally {
      setUploadState(null);
    }
  }

  // ── text input state ───────────────────────────────────────────────────────
  const firstFont = config.allowedFonts[0] ?? null;
  const [newText, setNewText] = useState("");

  const fontFaces = FONTS.map((f) => `@font-face{font-family:"${f.family}";src:url("${fontUrl(f.id)}") format("truetype");font-display:swap;}`).join("");

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,560px)_1fr]">
      <style>{fontFaces}</style>

      {/* ── canvas column ── */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1" role="group" aria-label="Garment side">
            {(["front", "back"] as const).map((s) => (
              <Button
                key={s}
                size="sm"
                variant={side === s ? "default" : "outline"}
                className="capitalize"
                onClick={() => {
                  setSide(s);
                  setSelectedLayerId(null);
                  setActiveAreaId(config.placementAreas.find((a) => a.side === s)?.id ?? null);
                }}
              >
                {s}
              </Button>
            ))}
          </div>
          <div className="ml-auto flex gap-1">
            <Button size="sm" variant="outline" onClick={undo} disabled={past.length === 0}>
              Undo
            </Button>
            <Button size="sm" variant="outline" onClick={redo} disabled={future.length === 0}>
              Redo
            </Button>
          </div>
        </div>
        {fontsReady ? (
          <DesignCanvas
            garment={garments[side]}
            areas={areasOnSide}
            layers={layersOnSide}
            uploadUrls={uploadUrls}
            selectedLayerId={selectedLayerId}
            activeAreaId={activeArea?.id ?? null}
            onSelect={(id) => {
              setSelectedLayerId(id);
              const layer = spec.layers.find((l) => l.id === id);
              if (layer) setActiveAreaId(layer.areaId);
            }}
            onLayerChange={(id, box) => updateLayer(id, (l) => ({ ...l, ...box }))}
            onRejected={(text) => setMessage({ kind: "error", text })}
          />
        ) : (
          <div className="flex aspect-[1200/1560] w-full max-w-[560px] items-center justify-center rounded-xl bg-muted text-sm text-muted-foreground">
            Loading fonts…
          </div>
        )}
        <p className="text-xs text-muted-foreground">Drag items to move them. Use the corner handles to resize or rotate. Items stay inside the dashed areas.</p>

        {(props.initialDesign?.referencePhotoUrl || (props.alternatives && props.alternatives.length > 0)) && (
          <div className="flex flex-wrap items-start gap-3 rounded-xl border p-3 text-sm" data-testid="start-info">
            {props.initialDesign?.referencePhotoUrl && (
              <figure className="flex flex-col gap-1">
                <span className="relative block h-28 w-20 overflow-hidden rounded-lg bg-muted">
                  <Image src={props.initialDesign.referencePhotoUrl} alt="Your reference photo" fill unoptimized className="object-cover" />
                </span>
                <figcaption className="text-xs text-muted-foreground">Your photo</figcaption>
              </figure>
            )}
            <div className="flex flex-col gap-1">
              <p>{spec.startedFrom === "photo" ? "We matched your photo to this dress and copied its main colors." : "We matched your description to this dress."}</p>
              {props.alternatives && props.alternatives.length > 0 && (
                <p className="text-muted-foreground">
                  Other good matches:{" "}
                  {props.alternatives.map((alt, i) => (
                    <span key={alt.productId}>
                      {i > 0 && ", "}
                      <Link href={`/customize/${alt.productId}`} className="underline">
                        {alt.name}
                      </Link>
                    </span>
                  ))}
                </p>
              )}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Button variant="outline" className="self-start" aria-expanded={showTryOn} onClick={() => setShowTryOn((v) => !v)}>
            {showTryOn ? "Hide try-on" : "See it on me"}
          </Button>
          {showTryOn && (
            <TryOnPanel
              source={{ kind: "design", spec, designId }}
              signedIn={props.customerId !== null}
              onSignIn={() => handleResult({ status: "signin" }, () => undefined)}
            />
          )}
        </div>

        {props.aiEnabled ? (
          <AiBox
            initialJobId={props.initialAiJobId ?? null}
            designId={designId}
            spec={spec}
            signedIn={props.customerId !== null}
            onDesignId={(id) => {
              if (!designId) {
                setIsDraft(true);
              }
              setDesignId(id);
              // Keep the draft (and its AI rounds) if the page is reloaded.
              router.replace(`/customize/${props.productId}?design=${id}`, { scroll: false });
            }}
            onPick={(picked, imageUrls, label) => {
              setUploadUrls((u) => ({ ...u, ...imageUrls }));
              setSelectedLayerId(null);
              commit(picked);
              setMessage({ kind: "ok", text: `Applied ${label}. Keep editing it, or press Undo to go back.` });
            }}
            onSignIn={() => handleResult({ status: "signin" }, () => undefined)}
          />
        ) : (
          <div className="rounded-xl border border-dashed p-4" data-testid="ai-box">
            <p className="font-medium">AI design box</p>
            <p className="text-sm text-muted-foreground">AI design isn&apos;t available for this dress.</p>
          </div>
        )}
      </div>

      {/* ── controls column ── */}
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold">Design your {props.productName}</h1>
          <p className="text-sm text-muted-foreground">Clothing brand logos can&apos;t be used.</p>
        </div>

        <Panel title="Size">
          <div className="flex flex-wrap gap-2">
            {props.availableSizes.map((size) => (
              <button
                key={size}
                type="button"
                aria-pressed={spec.size === size}
                onClick={() => commit((s) => ({ ...s, size }))}
                className={cn("h-9 min-w-12 rounded-lg border px-3 text-sm", spec.size === size ? "border-foreground bg-foreground text-background" : "hover:bg-muted")}
              >
                {size}
              </button>
            ))}
          </div>
        </Panel>

        <Panel title="Style">
          <div className="flex flex-col gap-4">
            {STYLE_GROUPS.map((group) => (
              <fieldset key={group} className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium">{GROUP_LABEL[group]}</legend>
                <div className="flex flex-wrap gap-2">
                  {config.styleOptions[group].map((option) => {
                    const ref = option.referenceImageKey ? props.imageUrls[option.referenceImageKey] : undefined;
                    const chosen = spec.styleOptions[group] === option.id;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        aria-pressed={chosen}
                        onClick={() => commit((s) => ({ ...s, styleOptions: { ...s.styleOptions, [group]: option.id } }))}
                        className={cn("flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm", chosen ? "border-foreground bg-foreground text-background" : "hover:bg-muted")}
                      >
                        {ref && (
                          <span className="relative size-8 overflow-hidden rounded bg-muted">
                            <Image src={ref} alt="" fill unoptimized className="object-cover" />
                          </span>
                        )}
                        {option.label}
                        {option.addOnPriceMinor > 0 && <span className="opacity-70">+{formatBDT(option.addOnPriceMinor)}</span>}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            ))}
          </div>
        </Panel>

        <Panel title="Colors and patterns">
          <div className="flex flex-col gap-4">
            {config.regions
              .filter((r) => r.recolorable && (r.masks.front || r.masks.back))
              .map((region) => {
                const part = spec.parts[region.id];
                return (
                  <div key={region.id} className="flex flex-col gap-2" data-testid={`region-${region.id}`}>
                    <span className="text-sm font-medium">{region.label}</span>
                    <div className="flex flex-wrap gap-1.5" role="group" aria-label={`${region.label} color`}>
                      <Swatch label="Original" selected={!part} onClick={() => commit((s) => ({ ...s, parts: Object.fromEntries(Object.entries(s.parts).filter(([k]) => k !== region.id)) }))} />
                      {allowedColors.map((c) => (
                        <Swatch
                          key={c.name}
                          label={c.name}
                          color={c.hex}
                          selected={part?.color === c.hex.toLowerCase()}
                          onClick={() => commit((s) => ({ ...s, parts: { ...s.parts, [region.id]: { color: c.hex.toLowerCase(), pattern: s.parts[region.id]?.pattern } } }))}
                        />
                      ))}
                    </div>
                    {part && config.allowedPatterns.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <label className="flex items-center gap-2">
                          Pattern
                          <select
                            value={part.pattern?.id ?? ""}
                            onChange={(e) => {
                              const id = PATTERNS.find((p) => p.id === e.target.value)?.id;
                              commit((s) => ({
                                ...s,
                                parts: { ...s.parts, [region.id]: { color: part.color, pattern: id ? { id, color: part.pattern?.color ?? defaultColor } : undefined } },
                              }));
                            }}
                            className="h-8 rounded-lg border border-input bg-transparent px-2"
                          >
                            <option value="">None</option>
                            {PATTERNS.filter((p) => config.allowedPatterns.includes(p.id)).map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.label} (+{formatBDT(config.addOns.patternMinor)})
                              </option>
                            ))}
                          </select>
                        </label>
                        {part.pattern && (
                          <div className="flex flex-wrap gap-1" role="group" aria-label={`${region.label} pattern color`}>
                            {allowedColors.map((c) => (
                              <Swatch
                                key={c.name}
                                small
                                label={`Pattern ${c.name}`}
                                color={c.hex}
                                selected={part.pattern?.color === c.hex.toLowerCase()}
                                onClick={() => {
                                  const patternId: PatternId | undefined = part.pattern?.id;
                                  if (patternId) commit((s) => ({ ...s, parts: { ...s.parts, [region.id]: { color: part.color, pattern: { id: patternId, color: c.hex.toLowerCase() } } } }));
                                }}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </Panel>

        <Panel title="Add to your design">
          {areasOnSide.length === 0 ? (
            <p className="text-sm text-muted-foreground">There are no print areas on the {side}. Switch sides to add text or images.</p>
          ) : (
            <div className="flex flex-col gap-4">
              <label className="flex items-center gap-2 text-sm">
                Area
                <select value={activeArea?.id ?? ""} onChange={(e) => setActiveAreaId(e.target.value)} className="h-8 rounded-lg border border-input bg-transparent px-2">
                  {areasOnSide.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label} ({a.widthCm}×{a.heightCm} cm)
                    </option>
                  ))}
                </select>
              </label>

              {firstFont && activeArea && (
                <div className="flex flex-wrap items-center gap-2">
                  <Input value={newText} maxLength={60} placeholder="Your text" aria-label="New text" onChange={(e) => setNewText(e.target.value)} className="h-8 w-48" />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!newText.trim()}
                    onClick={() => {
                      addLayer({
                        id: newLayerId(),
                        areaId: activeArea.id,
                        kind: "text",
                        ...centredBox(activeArea, 0.9, 3, 0.3),
                        text: { content: newText.trim(), fontId: firstFont, color: defaultColor },
                      });
                      setNewText("");
                    }}
                  >
                    Add text (+{formatBDT(config.addOns.textMinor)})
                  </Button>
                </div>
              )}

              {config.allowedDecorations.length > 0 && activeArea && (
                <div className="flex flex-col gap-1">
                  <span className="text-sm">Decorations (+{formatBDT(config.addOns.decorationMinor)} each)</span>
                  <div className="flex flex-wrap gap-1.5">
                    {DECORATIONS.filter((d) => config.allowedDecorations.includes(d.id)).map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        aria-label={`Add ${d.label}`}
                        title={d.label}
                        onClick={() => addLayer({ id: newLayerId(), areaId: activeArea.id, kind: "decoration", ...centredBox(activeArea, 0.35, 1, 0.72), decoration: { id: d.id, color: defaultColor } })}
                        className="flex size-10 items-center justify-center rounded-lg border hover:bg-muted"
                      >
                        <DecorationIcon id={d.id} />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {activeArea && (
                <div className="flex flex-col gap-2 text-sm">
                  <span>Your image or logo (+{formatBDT(config.addOns.imageMinor)})</span>
                  <div className="flex flex-wrap items-center gap-3">
                    <label className={cn("inline-flex h-8 cursor-pointer items-center rounded-lg border px-3 hover:bg-muted", uploadState && "pointer-events-none opacity-60")}>
                      {uploadState ?? "Upload image"}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        className="sr-only"
                        onChange={(e) => {
                          const file = e.currentTarget.files?.[0];
                          e.currentTarget.value = "";
                          if (file) void uploadImage(file);
                        }}
                      />
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" className="size-4" checked={removeBg} onChange={(e) => setRemoveBg(e.target.checked)} />
                      Remove background
                    </label>
                  </div>
                  <p className="text-xs text-muted-foreground">JPEG, PNG or WebP up to 4 MB. Clothing brand logos can&apos;t be used.</p>
                </div>
              )}
            </div>
          )}
        </Panel>

        {selectedLayer && (
          <Panel title="Selected item">
            <div className="flex flex-col gap-3 text-sm" data-testid="selected-layer">
              {selectedLayer.kind === "text" && (
                <>
                  <Input
                    aria-label="Text"
                    value={selectedLayer.text.content}
                    maxLength={60}
                    onChange={(e) => updateLayer(selectedLayer.id, (l) => (l.kind === "text" ? { ...l, text: { ...l.text, content: e.target.value } } : l))}
                  />
                  <label className="flex items-center gap-2">
                    Font
                    <select
                      value={selectedLayer.text.fontId}
                      onChange={(e) => {
                        const fontId: FontId | undefined = FONTS.find((f) => f.id === e.target.value)?.id;
                        if (fontId) updateLayer(selectedLayer.id, (l) => (l.kind === "text" ? { ...l, text: { ...l.text, fontId } } : l));
                      }}
                      className="h-8 rounded-lg border border-input bg-transparent px-2"
                    >
                      {FONTS.filter((f) => config.allowedFonts.includes(f.id)).map((f) => (
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
                  {allowedColors.map((c) => (
                    <Swatch
                      key={c.name}
                      small
                      label={c.name}
                      color={c.hex}
                      selected={(selectedLayer.kind === "text" ? selectedLayer.text.color : selectedLayer.decoration.color) === c.hex.toLowerCase()}
                      onClick={() =>
                        updateLayer(selectedLayer.id, (l) =>
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
                <Button size="sm" variant="outline" onClick={() => moveLayer(selectedLayer.id, 1)}>
                  Bring forward
                </Button>
                <Button size="sm" variant="outline" onClick={() => moveLayer(selectedLayer.id, -1)}>
                  Send backward
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    commit((s) => ({ ...s, layers: s.layers.filter((l) => l.id !== selectedLayer.id) }));
                    setSelectedLayerId(null);
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
          </Panel>
        )}

        <Panel title="Price">
          {price ? (
            <ul className="flex flex-col gap-1 text-sm" data-testid="price-breakdown">
              {price.lines.map((line) => (
                <li key={line.label} className="flex justify-between">
                  <span>{line.label}</span>
                  <span>{formatBDT(line.amountMinor)}</span>
                </li>
              ))}
              <li className="mt-1 flex justify-between border-t pt-2 font-semibold">
                <span>Total</span>
                <span data-testid="design-total">{formatBDT(price.totalMinor)}</span>
              </li>
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Choose a size to see the price.</p>
          )}
          <p className="text-xs text-muted-foreground">Final price is confirmed when you save. Custom dresses are made to order.</p>
        </Panel>

        {(issues.length > 0 || serverIssues.length > 0 || message) && (
          <div className="flex flex-col gap-1 text-sm">
            {message && (
              <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "text-destructive" : "text-emerald-700 dark:text-emerald-400"}>
                {message.text}
              </p>
            )}
            {[...issues, ...serverIssues].slice(0, 5).map((issue) => (
              <p key={`${issue.path}-${issue.message}`} className="text-destructive">
                {issue.message}
              </p>
            ))}
          </div>
        )}

        {spec.startedFrom === "photo" && (
          <QuoteRequest designId={designId} saved={designId !== null && !dirty && !isDraft} onSignIn={() => handleResult({ status: "signin" }, () => undefined)} />
        )}

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={save} disabled={pending || issues.length > 0}>
            {pending ? "Saving…" : designId && !dirty && !isDraft ? "Saved" : "Save design"}
          </Button>
          <Button onClick={addToCart} disabled={pending || issues.length > 0 || !price}>
            Add to cart
          </Button>
        </div>
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">{title}</h2>
      {children}
    </section>
  );
}

function Swatch({ label, color, selected, onClick, small }: { label: string; color?: string; selected: boolean; onClick: () => void; small?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      title={label}
      onClick={onClick}
      className={cn(
        "rounded-full ring-1 ring-black/15 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        small ? "size-6" : "size-8",
        selected && "ring-2 ring-foreground ring-offset-2",
        !color && "bg-[repeating-linear-gradient(45deg,#e5e5e5_0_4px,#ffffff_4px_8px)]",
      )}
      style={color && /^#[0-9a-f]{6}$/i.test(color) ? { backgroundColor: color } : undefined}
    />
  );
}

function DecorationIcon({ id }: { id: DecorationId }) {
  // Curated, code-defined SVG rendered as an image (never injected as HTML).
  return <Image src={decorationDataUrl(decorationSvg(id, "#444444", 64))} alt="" width={24} height={24} unoptimized />;
}
