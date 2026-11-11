import { cn } from "cn";

/** ClothSeeker's mark (a stitched seam and a button) with the name beside it. */
export function Logo({ className, tag }: { className?: string; tag?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <svg viewBox="0 0 32 32" className="size-8 shrink-0" aria-hidden>
        <circle cx="16" cy="16" r="16" className="fill-primary" />
        <path d="M8.5 21.5c2.6-10 12.4-10 15 0" fill="none" className="stroke-primary-foreground" strokeWidth="2" strokeLinecap="round" strokeDasharray="0.5 4" />
        <circle cx="16" cy="11" r="2.6" className="fill-brand" />
      </svg>
      <span className="font-heading text-xl leading-none font-semibold tracking-tight">ClothSeeker</span>
      {tag && <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-muted-foreground">{tag}</span>}
    </span>
  );
}
