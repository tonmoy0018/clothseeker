"use client";

import type { Canvas as FabricCanvas, FabricObject } from "fabric";
import { useEffect, useRef, useState } from "react";

import { decorationLayerSvg, decorationSvg, isPlainDecoration, repeatLayout, type DecorationRepeat } from "@/lib/catalog/decorations";
import { FONTS } from "@/lib/catalog/fonts";
import { applyFabricField, type FabricField } from "@/lib/design/fabric-warp";
import { layerFitsArea } from "@/lib/design/validate";
import type { DesignLayer } from "@/types/design-spec";
import type { PlacementArea } from "@/types/template";

import { decorationDataUrl, loadImage } from "./recolor";

export type LayerBox = Pick<DesignLayer, "x" | "y" | "w" | "h" | "rotation">;

type DesignCanvasProps = {
  /** Recolored garment for the current side (or null while composing). */
  garment: HTMLCanvasElement | null;
  /** Drawn over the items to trim what hangs off the fabric (areas with `clipToFabric`), or null. */
  offFabric: HTMLCanvasElement | null;
  /** The garment's fabric shape (same size as `garment`): items are drawn bent and shaded by it. */
  field: FabricField | null;
  areas: readonly PlacementArea[];
  layers: readonly DesignLayer[];
  uploadUrls: Readonly<Record<string, string>>;
  selectedLayerId: string | null;
  activeAreaId: string | null;
  onSelect: (layerId: string | null) => void;
  onLayerChange: (layerId: string, box: LayerBox) => void;
  /** Called when a move/resize/rotate would leave the area; the layer snaps back. */
  onRejected: (message: string) => void;
  /** The garment as drawn, with its items printed on it (for the live mirror). */
  onPrinted?: (garment: HTMLCanvasElement, printed: HTMLCanvasElement) => void;
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
          const d = layer.decoration;
          const look = { color: d.color, detail: d.detail, style: d.style, outline: d.outline, mirror: d.mirror };
          if (isPlainDecoration(look, d.repeat)) {
            object = new module.FabricImage(await loadImage(decorationDataUrl(decorationSvg(d.id, d.color, 200))));
          } else {
            // Drawn at the box's own shape (a border is wide), about 400 px on its long side.
            const px = areaPx(area);
            const boxW = layer.w * px.width;
            const boxH = layer.h * px.height;
            const k = 400 / Math.max(boxW, boxH, 1);
            object = new module.FabricImage(await loadImage(decorationDataUrl(decorationLayerSvg(d.id, look, d.repeat, boxW * k, boxH * k))));
          }
        } else {
          const url = props.uploadUrls[layer.image.assetKey];
          if (!url) {
            continue;
          }
          const picture = await loadImage(url);
          if (layer.image.mirror || layer.image.repeat) {
            // Drawn at the box's own shape like a customised decoration, about 400 px on its long side.
            const px = areaPx(area);
            const k = 400 / Math.max(layer.w * px.width, layer.h * px.height, 1);
            object = new module.FabricImage(imageLayerCanvas(picture, layer.image, layer.w * px.width * k, layer.h * px.height * k));
          } else {
            object = new module.FabricImage(picture);
          }
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
      canvas.overlayImage = props.offFabric
        ? new module.FabricImage(props.offFabric, { originX: "left", originY: "top", left: 0, top: 0, scaleX: scale, scaleY: scale, selectable: false, evented: false })
        : undefined;

      // Only the area in use is outlined: large areas (whole front, bodice, skirt) overlap.
      for (const area of props.areas.filter((a) => a.id === props.activeAreaId)) {
        const px = areaPx(area);
        canvas.add(
          new module.Rect({
            ...px,
            originX: "left",
            originY: "top",
            fill: area.clipToFabric ? "transparent" : "rgba(37,99,235,0.06)",
            stroke: "#2563eb",
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
      // Draw the items as printed on the fabric: render them flat at the garment's resolution, bend and
      // shade them with the fabric field, and put the result into the background. The editable objects
      // stay (invisible) on top for dragging; the one being moved shows flat while it moves.
      const field = props.field;
      if (field && objects.length > 0 && field.width === garment.width) {
        const guides = canvas.getObjects().filter((o) => !objects.includes(o));
        for (const guide of guides) guide.visible = false;
        canvas.backgroundImage = undefined;
        const overlay = canvas.overlayImage;
        canvas.overlayImage = undefined;
        const flat = canvas.toCanvasElement(garment.width / width);
        canvas.backgroundImage = background;
        canvas.overlayImage = overlay;
        for (const guide of guides) guide.visible = true;
        const flatPixels = flat.getContext("2d")?.getImageData(0, 0, field.width, field.height);
        const composite = document.createElement("canvas");
        composite.width = garment.width;
        composite.height = garment.height;
        const ctx = composite.getContext("2d");
        if (flatPixels && ctx && flat.width === field.width && flat.height === field.height) {
          const shaped = ctx.createImageData(field.width, field.height);
          applyFabricField(flatPixels.data, shaped.data, field);
          const printed = document.createElement("canvas");
          printed.width = field.width;
          printed.height = field.height;
          printed.getContext("2d")?.putImageData(shaped, 0, 0);
          ctx.drawImage(garment, 0, 0);
          ctx.drawImage(printed, 0, 0);
          propsRef.current.onPrinted?.(garment, composite);
          canvas.backgroundImage = new module.FabricImage(composite, { originX: "left", originY: "top", left: 0, top: 0, scaleX: scale, scaleY: scale, selectable: false, evented: false });
          for (const object of objects) object.set({ opacity: 0 });
          const showWhileMoving = ({ target }: { target: FabricObject }) => {
            if (target.opacity !== 0.75) target.set({ opacity: 0.75 });
          };
          canvas.on("object:moving", showWhileMoving);
          canvas.on("object:scaling", showWhileMoving);
          canvas.on("object:rotating", showWhileMoving);
        }
      }
      canvas.requestRenderAll();
    });
  }, [ready, width, resetTick, props.garment, props.offFabric, props.field, props.areas, props.layers, props.uploadUrls, props.selectedLayerId, props.activeAreaId]);

  return (
    <div ref={wrapperRef} className="w-full max-w-[560px]" data-testid="design-canvas">
      <canvas ref={elementRef} aria-label="Design canvas: drag items to move, use the corner handles to resize or rotate" />
      {!props.garment && <div className="flex aspect-[1200/1560] w-full items-center justify-center rounded-xl bg-muted text-sm text-muted-foreground">Loading…</div>}
    </div>
  );
}

/** A mirrored image, or a border of it, drawn into a canvas of the box's size (as the renderer does). */
function imageLayerCanvas(picture: HTMLImageElement, look: { mirror?: boolean; repeat?: DecorationRepeat }, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  const places = look.repeat
    ? repeatLayout(look.repeat.count, look.repeat.curve, canvas.width, canvas.height).map((p) => ({ ...p, w: p.size, h: p.size }))
    : [{ x: canvas.width / 2, y: canvas.height / 2, w: canvas.width, h: canvas.height, angle: 0 }];
  for (const p of places) {
    const fit = Math.min(p.w / picture.naturalWidth, p.h / picture.naturalHeight);
    const w = picture.naturalWidth * fit;
    const h = picture.naturalHeight * fit;
    context.save();
    context.translate(p.x, p.y);
    context.rotate((p.angle * Math.PI) / 180);
    if (look.mirror) context.scale(-1, 1);
    context.drawImage(picture, -w / 2, -h / 2, w, h);
    context.restore();
  }
  return canvas;
}
