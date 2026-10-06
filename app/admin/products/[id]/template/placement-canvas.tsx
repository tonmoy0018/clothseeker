"use client";

import Image from "next/image";
import { useRef, type PointerEvent as ReactPointerEvent } from "react";

import { cn } from "@/lib/utils";

export type Rect = { x: number; y: number; w: number; h: number };

type Area = { id: string; label: string; rect: Rect };

type PlacementCanvasProps = {
  imageUrl: string | null;
  areas: readonly Area[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChange: (id: string, rect: Rect) => void;
};

const MIN_SIZE = 0.03;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const round = (v: number) => Math.round(v * 1000) / 1000;

type Drag = { mode: "draw"; anchorX: number; anchorY: number } | { mode: "move"; offX: number; offY: number; w: number; h: number };

/**
 * Garment image with placement rectangles. Drag on empty space to (re)draw the selected area,
 * drag inside it to move it. Coordinates are fractions of the image (0–1).
 */
export function PlacementCanvas({ imageUrl, areas, selectedId, onSelect, onChange }: PlacementCanvasProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const selected = areas.find((a) => a.id === selectedId) ?? null;

  function point(event: ReactPointerEvent): { x: number; y: number } {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) {
      return { x: 0, y: 0 };
    }
    return {
      x: clamp((event.clientX - box.left) / box.width, 0, 1),
      y: clamp((event.clientY - box.top) / box.height, 0, 1),
    };
  }

  function startDrag(event: ReactPointerEvent, area: Area | null) {
    if (!selected && !area) {
      return;
    }
    event.preventDefault();
    boxRef.current?.setPointerCapture(event.pointerId);
    const p = point(event);
    const target = area ?? selected;
    if (!target) {
      return;
    }
    if (area && area.id !== selectedId) {
      onSelect(area.id);
    }
    const r = target.rect;
    const inside = p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
    dragRef.current = inside
      ? { mode: "move", offX: p.x - r.x, offY: p.y - r.y, w: r.w, h: r.h }
      : { mode: "draw", anchorX: p.x, anchorY: p.y };
  }

  function onPointerMove(event: ReactPointerEvent) {
    const drag = dragRef.current;
    const targetId = selectedId;
    if (!drag || !targetId) {
      return;
    }
    const p = point(event);
    if (drag.mode === "move") {
      onChange(targetId, {
        x: round(clamp(p.x - drag.offX, 0, 1 - drag.w)),
        y: round(clamp(p.y - drag.offY, 0, 1 - drag.h)),
        w: drag.w,
        h: drag.h,
      });
    } else {
      const x = Math.min(drag.anchorX, p.x);
      const y = Math.min(drag.anchorY, p.y);
      const w = Math.max(Math.abs(p.x - drag.anchorX), MIN_SIZE);
      const h = Math.max(Math.abs(p.y - drag.anchorY), MIN_SIZE);
      onChange(targetId, { x: round(Math.min(x, 1 - w)), y: round(Math.min(y, 1 - h)), w: round(w), h: round(h) });
    }
  }

  function endDrag(event: ReactPointerEvent) {
    dragRef.current = null;
    if (boxRef.current?.hasPointerCapture(event.pointerId)) {
      boxRef.current.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <div
      ref={boxRef}
      className="relative w-full max-w-sm touch-none select-none overflow-hidden rounded-lg border bg-muted"
      onPointerDown={(e) => startDrag(e, null)}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      data-testid="placement-canvas"
    >
      {imageUrl ? (
        <Image src={imageUrl} alt="Garment" width={1200} height={1560} unoptimized draggable={false} className="pointer-events-none block h-auto w-full" />
      ) : (
        <div className="flex aspect-[1200/1560] items-center justify-center p-6 text-center text-sm text-muted-foreground">
          Upload a garment image to position areas on it.
        </div>
      )}
      {areas.map((area) => (
        <div
          key={area.id}
          role="button"
          tabIndex={0}
          aria-label={`Placement area ${area.label}`}
          aria-pressed={area.id === selectedId}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              onSelect(area.id);
            }
          }}
          onPointerDown={(e) => {
            e.stopPropagation();
            startDrag(e, area);
          }}
          className={cn(
            "absolute flex items-start justify-start border-2 text-[10px] font-medium",
            area.id === selectedId
              ? "cursor-move border-blue-600 bg-blue-500/20 text-blue-900"
              : "cursor-pointer border-dashed border-foreground/50 bg-foreground/5 text-foreground/70",
          )}
          style={{
            left: `${area.rect.x * 100}%`,
            top: `${area.rect.y * 100}%`,
            width: `${area.rect.w * 100}%`,
            height: `${area.rect.h * 100}%`,
          }}
        >
          <span className="m-0.5 rounded bg-background/80 px-1">{area.label}</span>
        </div>
      ))}
    </div>
  );
}
