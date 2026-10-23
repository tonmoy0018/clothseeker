import type { Size } from "@/lib/generated/prisma/enums";

import { GARMENT_TYPES, type Audience, type GarmentType } from "./garment-types";

/** Brand-wide body measurements in centimetres, one chart for women's and one for men's clothing. */
export type SizeChart = {
  /** Measurement names, e.g. Bust, Waist, Hip. */
  columns: readonly string[];
  rows: readonly { size: Size; cm: readonly (readonly [number, number])[] }[];
};

export const SIZE_ORDER: readonly Size[] = ["XS", "S", "M", "L", "XL", "XXL"];

const SIZE_CHARTS: Record<Audience, SizeChart> = {
  women: {
    columns: ["Bust", "Waist", "Hip"],
    rows: [
      { size: "XS", cm: [[78, 82], [60, 64], [84, 88]] },
      { size: "S", cm: [[82, 86], [64, 68], [88, 92]] },
      { size: "M", cm: [[86, 92], [68, 74], [92, 98]] },
      { size: "L", cm: [[92, 98], [74, 80], [98, 104]] },
      { size: "XL", cm: [[98, 106], [80, 88], [104, 112]] },
      { size: "XXL", cm: [[106, 114], [88, 96], [112, 120]] },
    ],
  },
  men: {
    columns: ["Chest", "Waist", "Neck"],
    rows: [
      { size: "XS", cm: [[84, 88], [70, 74], [36, 37]] },
      { size: "S", cm: [[88, 94], [74, 80], [37, 38]] },
      { size: "M", cm: [[94, 100], [80, 86], [39, 40]] },
      { size: "L", cm: [[100, 106], [86, 92], [41, 42]] },
      { size: "XL", cm: [[106, 112], [92, 98], [43, 44]] },
      { size: "XXL", cm: [[112, 120], [98, 106], [45, 46]] },
    ],
  },
};

/** The size chart for a kind of garment. */
export function sizeChartFor(type: GarmentType): SizeChart {
  return SIZE_CHARTS[GARMENT_TYPES[type].audience];
}

export function compareSizes(a: Size, b: Size): number {
  return SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b);
}
