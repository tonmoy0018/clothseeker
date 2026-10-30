"use client";

import { X } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { DEFAULT_STRENGTH } from "@/lib/cutouts/rules";
import type { CutoutSource, CutoutView } from "@/lib/cutouts/service";
import { cn } from "@/lib/utils";
import type { TemplateConfig } from "@/types/template";

import { createCutoutAction, loadCutoutsAction } from "./cutout-actions";

// "Take a decoration from another dress": pick a ClothSeeker dress, draw a box around a decoration on
// its photo, and the server cuts it out (fabric removed). Its main colours can be swapped for this
// design's colours; then it's placed like an image. Earlier cut-outs can be reused.

type Box = { x: number; y: number; w: number; h: number };

const CHECKER = "bg-[repeating-conic-gradient(var(--color-muted)_0%_25%,var(--color-background)_0%_50%)] bg-[length:16px_16px]";

export function CutoutDialog(props: {
  config: TemplateConfig;
  /** The product being designed (its colours are the ones offered for swaps). */
  designProductId: string;
  onUse: (cutout: CutoutView) => void;
  onClose: () => void;
  onSignIn: () => void;
}) {
  // The parent's sign-in handler may change identity on every render; the data loads once.
  const signIn = useRef(props.onSignIn);
  useEffect(() => {
    signIn.current = props.onSignIn;
  });
  const onSignIn = () => signIn.current();
  const [data, setData] = useState<{ sources: CutoutSource[]; cutouts: CutoutView[]; left: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<CutoutSource | null>(null);
  const [photoIndex, setPhotoIndex] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [strength, setStrength] = useState(DEFAULT_STRENGTH);
  const [result, setResult] = useState<CutoutView | null>(null);
  const [swaps, setSwaps] = useState<(string | null)[]>([]);
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let live = true;
    void loadCutoutsAction().then((r) => {
      if (!live) return;
      if (r.status === "signin") signIn.current();
      else if (r.status === "error") setError(r.message);
      else setData({ sources: r.sources, cutouts: r.cutouts, left: r.left });
    });
    return () => {
      live = false;
    };
  }, []);

  function choose(next: CutoutSource) {
    setSource(next);
    setPhotoIndex(next.photos[0]?.index ?? 0);
    setBox(null);
    setResult(null);
    setError(null);
  }

  /** Pointer position as fractions of the photo. */
  function at(e: PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)) };
  }

  async function cut(nextSwaps: (string | null)[]) {
    if (!source || !box) return;
    setBusy(true);
    setError(null);
    const r = await createCutoutAction({ productId: source.productId, imageIndex: photoIndex, box, strength, swaps: nextSwaps, designProductId: props.designProductId });
    setBusy(false);
    if (r.status === "signin") {
      onSignIn();
    } else if (r.status === "error") {
      setError(r.message);
    } else {
      setResult(r.cutout);
      setSwaps(nextSwaps.length > 0 ? nextSwaps : r.cutout.palette.map(() => null));
      setData((d) => (d ? { ...d, cutouts: [r.cutout, ...d.cutouts], left: Math.max(0, d.left - 1) } : d));
    }
  }

  const photo = source?.photos.find((p) => p.index === photoIndex) ?? source?.photos[0] ?? null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Take a decoration from a dress" data-testid="cutout-dialog">
      <div className="flex max-h-full w-full max-w-3xl flex-col gap-4 overflow-y-auto rounded-xl bg-background p-4 shadow-lg">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-lg font-medium">Take a decoration from a dress</h2>
            <p className="text-sm text-muted-foreground">Draw a box around embroidery, lace or a print on one of our dresses. We&apos;ll cut it out for your design.</p>
          </div>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={props.onClose}>
            <X className="size-4" />
          </Button>
        </div>

        {!data && !error && <p className="text-sm text-muted-foreground">Loading dresses…</p>}

        {data && data.cutouts.length > 0 && !source && (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Your cut-outs</h3>
            <div className="flex flex-wrap gap-2">
              {data.cutouts.map((c) =>
                c.url ? (
                  <button key={c.id} type="button" className={cn("flex w-24 flex-col items-center gap-1 rounded-lg border p-1 text-xs hover:bg-muted")} onClick={() => props.onUse(c)} aria-label={`Use the cut-out from ${c.productName}`}>
                    <span className={cn("flex h-20 w-full items-center justify-center rounded", CHECKER)}>
                      <Image src={c.url} alt="" width={80} height={80} unoptimized className="max-h-20 w-auto object-contain" />
                    </span>
                    <span className="line-clamp-1">{c.productName}</span>
                  </button>
                ) : null,
              )}
            </div>
          </section>
        )}

        {data && !source && (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Choose a dress</h3>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {data.sources.map((s) => (
                <button key={s.productId} type="button" className="flex flex-col gap-1 rounded-lg border p-1 text-left text-xs hover:bg-muted" onClick={() => choose(s)}>
                  {s.photos[0] && <Image src={s.photos[0].url} alt="" width={120} height={120} unoptimized className="aspect-square w-full rounded object-cover" />}
                  <span className="line-clamp-2">{s.name}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {source && photo && (
          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{source.name}</span>
                <Button variant="ghost" size="sm" onClick={() => setSource(null)}>
                  Other dresses
                </Button>
              </div>
              <div
                className="relative cursor-crosshair touch-none select-none"
                data-testid="cutout-photo"
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  drag.current = at(e);
                  setBox(null);
                }}
                onPointerMove={(e) => {
                  const start = drag.current;
                  if (!start) return;
                  const p = at(e);
                  setBox({ x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) });
                }}
                onPointerUp={() => {
                  drag.current = null;
                  setBox((b) => (b && b.w > 0.02 && b.h > 0.02 ? b : null));
                }}
              >
                <Image src={photo.url} alt={`${source.name}: draw a box around the decoration`} width={600} height={600} unoptimized draggable={false} className="h-auto w-full rounded-lg" />
                {box && (
                  <div
                    className="pointer-events-none absolute border-2 border-dashed border-primary bg-primary/10"
                    style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }}
                  />
                )}
              </div>
              {source.photos.length > 1 && (
                <div className="flex gap-2" role="group" aria-label="Photos">
                  {source.photos.map((p) => (
                    <button
                      key={p.index}
                      type="button"
                      aria-pressed={p.index === photoIndex}
                      aria-label={`Photo ${p.index + 1}`}
                      className={cn("overflow-hidden rounded border-2", p.index === photoIndex ? "border-foreground" : "border-transparent")}
                      onClick={() => {
                        setPhotoIndex(p.index);
                        setBox(null);
                      }}
                    >
                      <Image src={p.url} alt="" width={56} height={56} unoptimized className="size-14 object-cover" />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex w-full flex-col gap-3 sm:w-64">
              <p className="text-sm text-muted-foreground">{box ? "Box drawn. Adjust how much fabric to remove, then cut it out." : "Drag on the photo to draw a box around a decoration."}</p>
              <label className="flex flex-col gap-1 text-sm">
                <span>Remove fabric</span>
                <input type="range" min={0} max={100} value={Math.round(strength * 100)} aria-label="Remove fabric" onChange={(e) => setStrength(Number(e.target.value) / 100)} />
                <span className="flex justify-between text-xs text-muted-foreground">
                  <span>Keep fine stitches</span>
                  <span>Cleaner</span>
                </span>
              </label>
              <Button disabled={!box || busy || data?.left === 0} onClick={() => void cut([])}>
                {busy ? "Cutting out…" : "Cut out"}
              </Button>
              {data && <p className="text-xs text-muted-foreground">{data.left} cut-outs left today.</p>}

              {result?.url && (
                <div className="flex flex-col gap-2" data-testid="cutout-result">
                  <div className={cn("flex h-40 items-center justify-center rounded-lg border", CHECKER)}>
                    <Image src={result.url} alt={`Decoration cut out of ${result.productName}`} width={160} height={160} unoptimized className="max-h-36 w-auto object-contain" />
                  </div>
                  {result.palette.length > 0 && (
                    <div className="flex flex-col gap-1 text-xs">
                      <span>Change its colours</span>
                      {result.palette.map((hex, i) => (
                        <label key={hex + i} className="flex items-center gap-2">
                          <span className="size-5 shrink-0 rounded-full border" style={{ backgroundColor: hex }} />
                          <select
                            className="h-7 min-w-0 flex-1 rounded border bg-background px-1"
                            aria-label={`New colour for colour ${i + 1}`}
                            value={swaps[i] ?? ""}
                            onChange={(e) => setSwaps((s) => result.palette.map((_, j) => (j === i ? e.target.value || null : (s[j] ?? null))))}
                          >
                            <option value="">Keep</option>
                            {props.config.allowedColors.map((c) => (
                              <option key={c.name} value={c.hex.toLowerCase()}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        </label>
                      ))}
                      <Button size="sm" variant="outline" disabled={busy || swaps.every((s) => s === null)} onClick={() => void cut(swaps)}>
                        Apply colours
                      </Button>
                    </div>
                  )}
                  <Button onClick={() => props.onUse(result)}>Use on my design</Button>
                </div>
              )}
            </div>
          </div>
        )}

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
