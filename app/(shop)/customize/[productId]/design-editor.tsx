"use client";

import { Redo2, Shirt, Undo2 } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FONTS, fontUrl } from "@/lib/catalog/fonts";
import { garmentPicture } from "@/lib/design/garment-variant";
import { priceDesign, type DesignPrice } from "@/lib/design/pricing";
import { validateDesignAgainstTemplate, type DesignIssue } from "@/lib/design/validate";
import type { Size } from "@/lib/generated/prisma/enums";
import { formatBDT } from "@/lib/money";
import { cn } from "@/lib/utils";
import { designSpecSchema, type DesignLayer, type DesignSpec } from "@/types/design-spec";
import type { PlacementArea, TemplateConfig } from "@/types/template";

import { addDesignToCartAction, saveDesignAction, uploadDesignImageAction, type DesignActionResult } from "./actions";
import { TryOnPanel } from "../../try-on-panel";

import { AiBox } from "./ai-box";
import { QuoteRequest } from "./quote-request";
import { DesignCanvas, type LayerBox } from "./design-canvas";
import { RailButton, SideThumb } from "./editor-ui";
import { FabricTab } from "./fabric-tab";
import { PersonaliseTab } from "./personalise-tab";
import { composeGarment, loadImage, type ClientFill } from "./recolor";
import { StyleTab } from "./style-tab";

const HISTORY_LIMIT = 50;

const TABS = [
  { id: "fabric", label: "Fabric" },
  { id: "style", label: "Style" },
  { id: "personalise", label: "Personalise" },
  { id: "ai", label: "AI ideas" },
] as const;
type TabId = (typeof TABS)[number]["id"];

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
    // The template's starting style (e.g. what the dress's photo shows), else each group's first option.
    styleOptions: p.config.defaultStyle ?? {
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
  // The garment picture for the chosen neckline/sleeve/length (same choice as the server renderer).
  const { neckline, sleeveLength, dressLength } = spec.styleOptions;
  const pictures = useMemo(() => {
    const choice = { neckline, sleeveLength, dressLength };
    return { front: garmentPicture(config, "front", choice), back: garmentPicture(config, "back", choice) };
  }, [config, neckline, sleeveLength, dressLength]);

  const fillsBySide = useMemo(() => {
    const fills = (s: "front" | "back"): ClientFill[] =>
      config.regions.flatMap((region) => {
        const part = spec.parts[region.id];
        const maskKey = pictures[s].maskFor(region.id);
        const maskUrl = maskKey ? props.imageUrls[maskKey] : undefined;
        return part && maskUrl && region.recolorable ? [{ maskUrl, color: part.color, pattern: part.pattern ?? null }] : [];
      });
    return { front: fills("front"), back: fills("back") };
  }, [config.regions, pictures, spec.parts, props.imageUrls]);

  useEffect(() => {
    let cancelled = false;
    for (const s of ["front", "back"] as const) {
      const key = pictures[s].garmentKey;
      const url = key ? props.imageUrls[key] : undefined;
      if (!url) {
        continue;
      }
      void composeGarment(url, fillsBySide[s], 900, config.recolor)
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
  }, [fillsBySide, pictures, props.imageUrls, config.recolor]);

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

  // ── layout state ───────────────────────────────────────────────────────────
  // A design started from a description opens on its AI round.
  const [tab, setTab] = useState<TabId>(props.initialAiJobId ? "ai" : "fabric");
  const [showPrice, setShowPrice] = useState(false);
  const firstFont = config.allowedFonts[0] ?? null;

  /** Regions the customer can colour on this dress (with a mask on some picture). */
  const colorableRegions = useMemo(
    () =>
      config.regions.filter(
        (r) => r.recolorable && (r.masks.front !== undefined || r.masks.back !== undefined || config.styleVariants.some((v) => v.masks[r.id] !== undefined)),
      ),
    [config.regions, config.styleVariants],
  );

  function showSide(s: "front" | "back") {
    setSide(s);
    setSelectedLayerId(null);
    setActiveAreaId(config.placementAreas.find((a) => a.side === s)?.id ?? null);
  }

  function chooseArea(area: PlacementArea) {
    if (area.side !== side) {
      setSide(area.side);
      setSelectedLayerId(null);
    }
    setActiveAreaId(area.id);
  }

  const fontFaces = FONTS.map((f) => `@font-face{font-family:"${f.family}";src:url("${fontUrl(f.id)}") format("truetype");font-display:swap;}`).join("");

  return (
    // Desktop: preview on the left (stays in view), configurator tabs on the right.
    // Phone: preview, then the tabs, with the size/price/cart bar pinned to the bottom.
    <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:items-start lg:gap-10">
      <style>{fontFaces}</style>

      {/* ── preview ── */}
      <div className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-4">
        <h1 className="text-2xl font-semibold lg:hidden">Design your {props.productName}</h1>
        <div className="relative flex justify-center rounded-2xl bg-[#f3f2ef] py-4 pr-16 pl-4 sm:px-16" data-testid="preview">
          {fontsReady ? (
            <DesignCanvas
              garment={garments[side]}
              areas={areasOnSide}
              layers={layersOnSide}
              uploadUrls={uploadUrls}
              selectedLayerId={selectedLayerId}
              activeAreaId={activeArea?.id ?? null}
              onSelect={(id) => {
                // The canvas reselects the current item after each redraw; only a newly picked one opens its controls.
                const picked = id !== null && id !== selectedLayerId;
                setSelectedLayerId(id);
                const layer = spec.layers.find((l) => l.id === id);
                if (layer) {
                  setActiveAreaId(layer.areaId);
                  if (picked) setTab("personalise");
                }
              }}
              onLayerChange={(id, box) => updateLayer(id, (l) => ({ ...l, ...box }))}
              onRejected={(text) => setMessage({ kind: "error", text })}
            />
          ) : (
            <div className="flex aspect-[1200/1560] w-full max-w-[560px] items-center justify-center text-sm text-muted-foreground">Loading fonts…</div>
          )}

          {/* Tool rail */}
          <div className="absolute top-3 right-3 flex flex-col gap-2">
            <RailButton label="Undo" onClick={undo} disabled={past.length === 0}>
              <Undo2 className="size-4" />
            </RailButton>
            <RailButton label="Redo" onClick={redo} disabled={future.length === 0}>
              <Redo2 className="size-4" />
            </RailButton>
            <RailButton label="See it on me" pressed={showTryOn} onClick={() => setShowTryOn((v) => !v)}>
              <Shirt className="size-4" />
            </RailButton>
          </div>
          <div className="absolute right-3 bottom-3 flex flex-col gap-2" role="group" aria-label="Garment side">
            {(["front", "back"] as const).filter((s) => pictures[s].garmentKey !== null).map((s) => (
              <SideThumb key={s} label={s === "front" ? "Front" : "Back"} garment={garments[s]} selected={side === s} onClick={() => showSide(s)} />
            ))}
          </div>
        </div>
        {!pictures[side].exact && (
          <p className="text-xs text-muted-foreground" data-testid="closest-picture">
            We don&apos;t have a picture of this exact style yet, so the preview shows the closest one. Your dress is made in the style you chose.
          </p>
        )}
        <p className="text-xs text-muted-foreground">Drag items to move them. Use the corner handles to resize or rotate. Items stay inside the dashed areas.</p>

        {showTryOn && (
          <TryOnPanel source={{ kind: "design", spec, designId }} signedIn={props.customerId !== null} onSignIn={() => handleResult({ status: "signin" }, () => undefined)} />
        )}

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
      </div>

      {/* ── configurator ── */}
      <div className="flex min-w-0 flex-col">
        <div className="mb-4">
          <h1 className="hidden text-2xl font-semibold lg:block">Design your {props.productName}</h1>
          <p className="text-sm text-muted-foreground">Clothing brand logos can&apos;t be used.</p>
        </div>

        <div role="tablist" aria-label="Design options" className="sticky top-0 z-10 grid grid-cols-4 border-b bg-background">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              onClick={() => setTab(t.id)}
              className={cn(
                "h-12 px-1 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                tab === t.id ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Panels stay mounted (hidden when inactive), so the AI box keeps polling and nothing resets. */}
        <div className="min-h-[24rem] pt-4">
          <div role="tabpanel" id="panel-fabric" aria-labelledby="tab-fabric" hidden={tab !== "fabric"}>
            {colorableRegions.length > 0 ? (
              <FabricTab config={config} spec={spec} regions={colorableRegions} onChangeParts={(change) => commit((s) => ({ ...s, parts: change(s.parts) }))} />
            ) : (
              <p className="text-sm text-muted-foreground">This dress comes in one fabric.</p>
            )}
          </div>
          <div role="tabpanel" id="panel-style" aria-labelledby="tab-style" hidden={tab !== "style"}>
            <StyleTab
              config={config}
              spec={spec}
              imageUrls={props.imageUrls}
              previewFollows={config.styleVariants.length > 0}
              onChoose={(group, optionId) => commit((s) => ({ ...s, styleOptions: { ...s.styleOptions, [group]: optionId } }))}
            />
          </div>
          <div role="tabpanel" id="panel-personalise" aria-labelledby="tab-personalise" hidden={tab !== "personalise"}>
            <PersonaliseTab
              config={config}
              activeArea={activeArea}
              onArea={chooseArea}
              selectedLayer={selectedLayer}
              onUpdateLayer={updateLayer}
              onMoveLayer={moveLayer}
              onDeleteLayer={(id) => {
                commit((s) => ({ ...s, layers: s.layers.filter((l) => l.id !== id) }));
                setSelectedLayerId(null);
              }}
              onAddText={(content) => {
                if (!activeArea || !firstFont) return;
                addLayer({ id: newLayerId(), areaId: activeArea.id, kind: "text", ...centredBox(activeArea, 0.9, 3, 0.3), text: { content, fontId: firstFont, color: defaultColor } });
              }}
              onAddDecoration={(id) => {
                if (!activeArea) return;
                addLayer({ id: newLayerId(), areaId: activeArea.id, kind: "decoration", ...centredBox(activeArea, 0.35, 1, 0.72), decoration: { id, color: defaultColor } });
              }}
              upload={{ state: uploadState, removeBackground: removeBg, setRemoveBackground: setRemoveBg, onFile: (file) => void uploadImage(file) }}
            />
          </div>
          <div role="tabpanel" id="panel-ai" aria-labelledby="tab-ai" hidden={tab !== "ai"}>
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
        </div>

        {/* ── size, price and cart: pinned to the bottom while scrolling ── */}
        <div className="sticky bottom-0 z-10 -mx-4 mt-6 flex flex-col gap-3 border-t bg-background/95 px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur lg:mx-0 lg:px-0">
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

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Size</span>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Dress size">
              {props.availableSizes.map((size) => (
                <button
                  key={size}
                  type="button"
                  aria-pressed={spec.size === size}
                  onClick={() => commit((s) => ({ ...s, size }))}
                  className={cn("h-8 min-w-10 rounded-lg border px-2.5 text-sm", spec.size === size ? "border-foreground bg-foreground text-background" : "hover:bg-muted")}
                >
                  {size}
                </button>
              ))}
            </div>
          </div>

          <div id="price-details" hidden={!showPrice}>
            {price && (
              <ul className="flex flex-col gap-1 rounded-lg bg-muted/40 p-3 text-sm" data-testid="price-breakdown">
                {price.lines.map((line) => (
                  <li key={line.label} className="flex justify-between gap-4">
                    <span>{line.label}</span>
                    <span className="tabular-nums">{formatBDT(line.amountMinor)}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1 text-xs text-muted-foreground">Final price is confirmed when you save. Custom dresses are made to order.</p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="mr-auto flex flex-col">
              <span className="text-xl font-semibold tabular-nums" data-testid="design-total">
                {price ? formatBDT(price.totalMinor) : "—"}
              </span>
              <button type="button" aria-expanded={showPrice} aria-controls="price-details" onClick={() => setShowPrice((v) => !v)} className="self-start text-xs text-muted-foreground underline underline-offset-2">
                {showPrice ? "Hide price details" : "Price details"}
              </button>
            </div>
            <Button variant="outline" onClick={save} disabled={pending || issues.length > 0}>
              {pending ? "Saving…" : designId && !dirty && !isDraft ? "Saved" : "Save design"}
            </Button>
            <Button onClick={addToCart} disabled={pending || issues.length > 0 || !price}>
              Add to cart
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
