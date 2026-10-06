import { cn } from "@/lib/utils";

const HEX = /^#[0-9a-f]{6}$/i;
const FALLBACK = "#B8B8B8";

type DressIllustrationProps = {
  colorHex: string;
  label: string;
  className?: string;
};

/**
 * Stand-in product image: a dress silhouette in the variant's color.
 * Real product photos replace this once uploads arrive in Phase 2.
 */
export function DressIllustration({ colorHex, label, className }: DressIllustrationProps) {
  const fill = HEX.test(colorHex) ? colorHex : FALLBACK;
  return (
    <div className={cn("flex items-center justify-center rounded-xl bg-muted", className)}>
      <svg viewBox="0 0 200 260" role="img" aria-label={label} className="h-4/5 w-4/5">
        <path
          d="M82 18 L88 18 L91 44 L109 44 L112 18 L118 18 L124 52 L128 100 L170 238 Q100 256 30 238 L72 100 L76 52 Z"
          fill={fill}
          stroke="rgba(0,0,0,0.18)"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path d="M72 100 Q100 108 128 100" fill="none" stroke="rgba(0,0,0,0.18)" strokeWidth="2" />
        <path d="M100 108 L100 246" fill="none" stroke="rgba(0,0,0,0.06)" strokeWidth="2" />
      </svg>
    </div>
  );
}
