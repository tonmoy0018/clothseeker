import type { Size } from "@/lib/generated/prisma/enums";

/** Brand-wide body measurements in centimetres. Every ClothSeeker dress uses this chart. */
export type SizeChartRow = {
  size: Size;
  bustCm: readonly [number, number];
  waistCm: readonly [number, number];
  hipCm: readonly [number, number];
};

export const SIZE_ORDER: readonly Size[] = ["XS", "S", "M", "L", "XL", "XXL"];

export const SIZE_CHART: readonly SizeChartRow[] = [
  { size: "XS", bustCm: [78, 82], waistCm: [60, 64], hipCm: [84, 88] },
  { size: "S", bustCm: [82, 86], waistCm: [64, 68], hipCm: [88, 92] },
  { size: "M", bustCm: [86, 92], waistCm: [68, 74], hipCm: [92, 98] },
  { size: "L", bustCm: [92, 98], waistCm: [74, 80], hipCm: [98, 104] },
  { size: "XL", bustCm: [98, 106], waistCm: [80, 88], hipCm: [104, 112] },
  { size: "XXL", bustCm: [106, 114], waistCm: [88, 96], hipCm: [112, 120] },
];

export function compareSizes(a: Size, b: Size): number {
  return SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b);
}
