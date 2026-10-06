"use client";

import type { Canvas as FabricCanvas, FabricObject } from "fabric";
import { useEffect, useRef, useState } from "react";

import { decorationSvg } from "@/lib/catalog/decorations";
import { FONTS } from "@/lib/catalog/fonts";
import { layerFitsArea } from "@/lib/design/validate";
import type { DesignLayer } from "@/types/design-spec";
import type { PlacementArea } from "@/types/template";

import { decorationDataUrl, loadImage } from "./recolor";

export type LayerBox = Pick<DesignLayer, "x" | "y" | "w" | "h" | "rotation">;

type DesignCanvasProps = {
  /** Recolored garment for the current side (or null while composing). */
  garment: HTMLCanvasElement | null;
  areas: readonly PlacementArea[];
  layers: readonly DesignLayer[];
  uploadUrls: Readonly<Record<string, string>>;
  selectedLayerId: string | null;
  activeAreaId: string | null;
  onSelect: (layerId: string | null) => void;
  onLayerChange: (layerId: string, box: LayerBox) => void;
  /** Called when a move/resize/rotate would leave the area; the layer snaps back. */
  onRejected: (message: string) => void;
};

type FabricModule = typeof import("fabric");

const familyOf = (fontId: string) => FONTS.find((f) => f.id === fontId)?.family ?? "sans-serif";
const normalizeAngle = (angle: number) => {
  const a = ((angle % 360) + 360) % 360;
  return Math.round((a > 180 ? a - 360 : a) * 10) / 10;
};

/**
 * Fabric.js view of one garment side. The DesignSpec (in the parent) is the source of truth:
 * this component rebuilds the scene from it and reports user transforms back as LayerBoxes.
 */
export function DesignCanvas(props: DesignCanvasProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const elementRef = useRef<HTMLCanvasElement>(null);
  const fabricRef = useRef<{ module: FabricModule; canvas: FabricCanvas } | null>(null);
  const propsRef = useRef(props);
  const generation = useRef(0);
  const [ready, setReady] = useState(false);
  const [width, setWidth] = useState(480);
  /** Bumped to rebuild the scene from the unchanged spec (snaps a rejected transform back). */
  const [resetTick, setResetTick] = useState(0);

  useEffect(() => {
    propsRef.current = props;
  });

  // Responsive width.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      const w = Math.floor(Math.min(entry?.contentRect.width ?? 480, 560));
      setWidth((current) => (Math.abs(current - w) > 4 ? w : current));
    });
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  // Create the Fabric canvas once (client only).
  useEffect(() => {
    let disposed = false;
    let canvas: FabricCanvas | null = null;
    void import("fabric").then((module) => {
      if (disposed || !elementRef.current) {
        return;
      }
      canvas = new module.Canvas(elementRef.current, { selection: false, preserveObjectStacking: true, uniformScaling: true });
      fabricRef.current = { module, canvas };
      setReady(true);
    });
    return () => {
      disposed = true;
      fabricRef.current = null;
      void canvas?.dispose();
    };
  }, []);

  // Rebuild the scene whenever the design, garment or size changes.
  useEffect(() => {
    const fabric = fabricRef.current;
    if (!ready || !fabric || !props.garment) {
      return;
    }
    const run = ++generation.current;
    const { module, canvas } = fabric;
    const garment = props.garment;
    const scale = width / garment.width;
    const height = Math.round(garment.height * scale);
    const layerIds = new WeakMap<FabricObject, string>();

    const areaPx = (area: PlacementArea) => ({
      left: area.rect.x * width,
      top: area.rect.y * height,
      width: area.rect.w * width,
      height: area.rect.h * height,
    });

    async function build() {
      const objects: FabricObject[] = [];
      for (const layer of props.layers) {
        const area = props.areas.find((a) => a.id === layer.areaId);
        if (!area) {
          continue;
        }
        let object: FabricObject;
        if (layer.kind === "text") {
          object = new module.FabricText(layer.text.content, { fontFamily: familyOf(layer.text.fontId), fill: layer.text.color, fontSize: 64 });
        } else if (layer.kind === "decoration") {
          object = new module.FabricImage(await loadImage(decorationDataUrl(decorationSvg(layer.decoration.id, layer.decoration.color, 200))));
        } else {
          const url = props.uploadUrls[layer.image.assetKey];
          if (!url) {
            continue;
          }
          object = new module.FabricImage(await loadImage(url));
        }
        const px = areaPx(area);
        const boxW = layer.w * px.width;
        const boxH = layer.h * px.height;
        const fit = Math.min(boxW / (object.width || 1), boxH / (object.height || 1));
        object.set({
          originX: "center",
          originY: "center",
          left: px.left + (layer.x + layer.w / 2) * px.width,
          top: px.top + (layer.y + layer.h / 2) * px.height,
          angle: layer.rotation,
          scaleX: fit,
          scaleY: fit,
          borderColor: "#2563eb",
          cornerColor: "#2563eb",
          cornerSize: 10,
          transparentCorners: false,
          lockScalingFlip: true,
          lockSkewingX: true,
          lockSkewingY: true,
        });
        // Corner handles only: keeps proportions, which is how the print renderer fits content.
        object.setControlsVisibility({ mt: false, mb: false, ml: false, mr: false });
        layerIds.set(object, layer.id);
        objects.push(object);
      }
      return objects;
    }

    void build().then((objects) => {
      if (run !== generation.current) {
        return;
      }
      canvas.off();
      canvas.clear();
      canvas.setDimensions({ width, height });
      // Fabric 7 defaults to centre origins; background and area guides are positioned by their top-left.
      const background = new module.FabricImage(garment, {
        originX: "left",
        originY: "top",
        left: 0,
        top: 0,
        scaleX: scale,
        scaleY: scale,
        selectable: false,
        evented: false,
      });
      canvas.backgroundImage = background;

      for (const area of props.areas) {
        const px = areaPx(area);
        const active = area.id === props.activeAreaId;
        canvas.add(
          new module.Rect({
            ...px,
            originX: "left",
            originY: "top",
            fill: active ? "rgba(37,99,235,0.06)" : "transparent",
            stroke: active ? "#2563eb" : "rgba(0,0,0,0.35)",
            strokeDashArray: [6, 4],
            strokeWidth: 1.5,
            selectable: false,
            evented: false,
          }),
        );
      }
      for (const object of objects) {
        canvas.add(object);
        if (layerIds.get(object) === props.selectedLayerId) {
          canvas.setActiveObject(object);
        }
      }

      const areaFor = (object: FabricObject) => {
        const id = layerIds.get(object);
        const layer = propsRef.current.layers.find((l) => l.id === id);
        return { id, area: propsRef.current.areas.find((a) => a.id === layer?.areaId) };
      };

      // Keep objects inside their area while dragging.
      canvas.on("object:moving", ({ target }) => {
        const { area } = areaFor(target);
        if (!area) {
          return;
        }
        const px = areaPx(area);
        const box = target.getBoundingRect();
        let dx = 0;
        let dy = 0;
        if (box.left < px.left) dx = px.left - box.left;
        else if (box.left + box.width > px.left + px.width) dx = px.left + px.width - (box.left + box.width);
        if (box.top < px.top) dy = px.top - box.top;
        else if (box.top + box.height > px.top + px.height) dy = px.top + px.height - (box.top + box.height);
        if (dx !== 0 || dy !== 0) {
          target.set({ left: (target.left ?? 0) + dx, top: (target.top ?? 0) + dy });
          target.setCoords();
        }
      });

      canvas.on("object:modified", ({ target }) => {
        const { id, area } = areaFor(target);
        if (!id || !area) {
          return;
        }
        const px = areaPx(area);
        const centre = target.getCenterPoint();
        const w = target.getScaledWidth() / px.width;
        const h = target.getScaledHeight() / px.height;
        const box: LayerBox = {
          x: Math.round(((centre.x - px.left) / px.width - w / 2) * 10_000) / 10_000,
          y: Math.round(((centre.y - px.top) / px.height - h / 2) * 10_000) / 10_000,
          w: Math.round(w * 10_000) / 10_000,
          h: Math.round(h * 10_000) / 10_000,
          rotation: normalizeAngle(target.angle ?? 0),
        };
        if (box.w > 1 || box.h > 1 || !layerFitsArea(box, area)) {
          propsRef.current.onRejected(`Keep items inside the dashed “${area.label}” area.`);
          setResetTick((t) => t + 1);
          return;
        }
        propsRef.current.onLayerChange(id, box);
      });

      const select = () => propsRef.current.onSelect(layerIds.get(canvas.getActiveObject() ?? background) ?? null);
      canvas.on("selection:created", select);
      canvas.on("selection:updated", select);
      canvas.on("selection:cleared", () => propsRef.current.onSelect(null));
      canvas.requestRenderAll();
    });
  }, [ready, width, resetTick, props.garment, props.areas, props.layers, props.uploadUrls, props.selectedLayerId, props.activeAreaId]);

  return (
    <div ref={wrapperRef} className="w-full max-w-[560px]" data-testid="design-canvas">
      <canvas ref={elementRef} aria-label="Design canvas: drag items to move, use the corner handles to resize or rotate" />
      {!props.garment && <div className="flex aspect-[1200/1560] w-full items-center justify-center rounded-xl bg-muted text-sm text-muted-foreground">Loading dress…</div>}
    </div>
  );
}
