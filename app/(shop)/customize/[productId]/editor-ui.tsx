"use client";

import { Check, Minus, Plus } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, type ReactNode } from "react";

import type { StyleIcon } from "@/lib/catalog/style-icons";
import { cn } from "@/lib/utils";

// Small building blocks for the design screen: picture tiles, accordion rows and colour swatches,
// in the style of a tailoring configurator.

/** A line drawing from lib/catalog/style-icons. */
export function LineIcon({ icon, className }: { icon: StyleIcon; className?: string }) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className={cn("fill-none stroke-current", className)} strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round">
      {icon.paths.map((d) => (
        <path key={d} d={d} />
      ))}
      {icon.dashed?.map((d) => (
        <path key={d} d={d} strokeDasharray="2 2" strokeWidth={0.8} className="opacity-50" />
      ))}
    </svg>
  );
}

/** A row that opens to show its options. */
export function AccordionRow(props: { id: string; title: string; value?: string; icon?: ReactNode; open: boolean; onToggle: () => void; children: ReactNode }) {
  const panelId = `${props.id}-panel`;
  return (
    <section className="border-b">
      <h3>
        <button type="button" aria-expanded={props.open} aria-controls={panelId} onClick={props.onToggle} className="flex h-14 w-full items-center gap-3 px-1 text-left hover:bg-muted/50">
          {props.icon && <span className="flex size-9 shrink-0 items-center justify-center text-muted-foreground">{props.icon}</span>}
          <span className="text-sm font-medium tracking-wide uppercase">{props.title}</span>
          {props.value && <span className="ml-auto truncate pl-2 text-sm text-muted-foreground">{props.value}</span>}
          <span className={cn("flex size-6 shrink-0 items-center justify-center text-muted-foreground", !props.value && "ml-auto")}>{props.open ? <Minus className="size-4" /> : <Plus className="size-4" />}</span>
        </button>
      </h3>
      <div id={panelId} hidden={!props.open} className="pb-5">
        {props.children}
      </div>
    </section>
  );
}

/** A picture tile: image area on top, caption below. Used for styles, fabrics and decorations. */
export function Tile(props: {
  label: string;
  /** Accessible name, when the visible label isn't enough (e.g. "Add Star"). */
  ariaLabel?: string;
  caption?: string;
  price?: string;
  selected?: boolean;
  onClick: () => void;
  children: ReactNode;
  /** Square picture (styles) or a wider fabric swatch. */
  shape?: "square" | "swatch";
  testId?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.selected === undefined ? undefined : props.selected}
      aria-label={props.ariaLabel}
      title={props.ariaLabel ?? props.label}
      onClick={props.onClick}
      data-testid={props.testId}
      className={cn(
        "group relative flex min-w-0 flex-col overflow-hidden rounded-lg border bg-background text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
        props.selected ? "border-foreground ring-1 ring-foreground" : "hover:border-foreground/40",
      )}
    >
      <span className={cn("relative flex w-full items-center justify-center overflow-hidden", props.shape === "swatch" ? "aspect-[4/3]" : "aspect-square bg-muted/40")}>{props.children}</span>
      <span className="flex items-baseline gap-1 border-t px-2 py-1.5">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">{props.label}</span>
          {props.caption && <span className="block truncate text-[0.65rem] tracking-wide text-muted-foreground uppercase">{props.caption}</span>}
        </span>
        {props.price && <span className="shrink-0 text-[0.7rem] text-muted-foreground tabular-nums">{props.price}</span>}
      </span>
      {props.selected && (
        <span className="absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full bg-foreground text-background">
          <Check className="size-3" />
        </span>
      )}
    </button>
  );
}

/** Style tile picture: the admin's reference image if there is one, otherwise a line drawing. */
export function StylePicture({ icon, imageUrl }: { icon: StyleIcon; imageUrl?: string }) {
  return imageUrl ? <Image src={imageUrl} alt="" fill unoptimized className="object-cover" /> : <LineIcon icon={icon} className="size-3/4 text-foreground/70" />;
}

export function Swatch({ label, color, selected, onClick, small }: { label: string; color?: string; selected: boolean; onClick: () => void; small?: boolean }) {
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

/** Round button on the preview's tool rail. */
export function RailButton({ label, onClick, disabled, pressed, children }: { label: string; onClick: () => void; disabled?: boolean; pressed?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex size-10 items-center justify-center rounded-full border bg-white text-neutral-800 shadow-sm transition-colors outline-none hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
        pressed && "border-neutral-900 bg-neutral-900 text-white hover:bg-neutral-800",
      )}
    >
      {children}
    </button>
  );
}

/** A small live copy of a composed garment side, for the front/back switch. */
export function SideThumb({ label, garment, selected, onClick }: { label: string; garment: HTMLCanvasElement | null; selected: boolean; onClick: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (garment) ctx.drawImage(garment, 0, 0, canvas.width, canvas.height);
  }, [garment]);
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      title={label}
      onClick={onClick}
      className={cn("overflow-hidden rounded-lg border-2 bg-white outline-none focus-visible:ring-2 focus-visible:ring-ring", selected ? "border-neutral-900" : "border-transparent opacity-70 hover:opacity-100")}
    >
      <canvas ref={ref} width={60} height={78} className="block h-[78px] w-[60px]" />
    </button>
  );
}
