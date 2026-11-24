import type { GarmentType } from "@/lib/catalog/garment-types";
import { cn } from "@/lib/utils";

const HEX = /^#[0-9a-f]{6}$/i;
const FALLBACK = "#B8B8B8";

type DressIllustrationProps = {
  colorHex: string;
  label: string;
  className?: string;
  /** Which silhouette to draw; a dress when left out. */
  garmentType?: GarmentType;
};

const OUTLINE = { stroke: "rgba(0,0,0,0.18)", strokeWidth: 2, strokeLinejoin: "round" as const };

/** A long-sleeved top with a collar and a centre placket; `hem` sets its length (a panjabi is longer). */
function TopSilhouette({ fill, hem }: { fill: string; hem: number }) {
  return (
    <>
      <path d={`M78 30 L92 22 L108 22 L122 30 L160 52 L176 140 L158 146 L140 80 L140 ${hem} L60 ${hem} L60 80 L42 146 L24 140 L40 52 Z`} fill={fill} {...OUTLINE} />
      <path d="M92 22 L100 40 L108 22 M92 22 L86 36 L100 40 L114 36 L108 22" fill={fill} {...OUTLINE} />
      <path d={`M100 40 L100 ${hem - 4}`} fill="none" stroke="rgba(0,0,0,0.12)" strokeWidth="2" />
    </>
  );
}

/**
 * Stand-in product image: a silhouette of the garment in the variant's color, shown while an item
 * has no photo.
 */
export function DressIllustration({ colorHex, label, className, garmentType = "dress" }: DressIllustrationProps) {
  const fill = HEX.test(colorHex) ? colorHex : FALLBACK;
  return (
    <div className={cn("flex items-center justify-center rounded-xl bg-muted", className)}>
      <svg viewBox="0 0 200 260" role="img" aria-label={label} className="h-4/5 w-4/5">
        {garmentType === "dress" ? (
          <>
            <path d="M82 18 L88 18 L91 44 L109 44 L112 18 L118 18 L124 52 L128 100 L170 238 Q100 256 30 238 L72 100 L76 52 Z" fill={fill} {...OUTLINE} />
            <path d="M72 100 Q100 108 128 100" fill="none" stroke="rgba(0,0,0,0.18)" strokeWidth="2" />
            <path d="M100 108 L100 246" fill="none" stroke="rgba(0,0,0,0.06)" strokeWidth="2" />
          </>
        ) : (
          <TopSilhouette fill={fill} hem={garmentType === "panjabi" ? 236 : 176} />
        )}
      </svg>
    </div>
  );
}
