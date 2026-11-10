import { styleGroupsOf, type GarmentType, type StyleGroup } from "@/lib/catalog/garment-types";

// Names of the style-picture files in prisma/style-photos/<slug>/, shared by the generator
// (scripts/ai/generate-style-photos.ts) and the seed. One option id per style group of the garment type,
// in the type's group order, separated by "--" (option ids may contain single hyphens, e.g. "v-neck"):
//   front--v-neck--short--midi.jpg      (dress: neckline, sleeves, length)
//   back--short--midi.jpg               (back views ignore the first group: neckline or collar)

export type Side = "front" | "back";
export type StyleChoice = Partial<Record<StyleGroup, string>>;

/** The groups a picture of this side shows: the back of a garment looks the same for every neckline or collar. */
export function pictureGroups(type: GarmentType, side: Side): readonly StyleGroup[] {
  const groups = styleGroupsOf(type);
  return side === "front" ? groups : groups.slice(1);
}

export function styleFileName(type: GarmentType, side: Side, choice: StyleChoice): string {
  return `${[side, ...pictureGroups(type, side).map((g) => choice[g] ?? "")].join("--")}.jpg`;
}

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The side and style choices a file name stands for, or null if it isn't a style picture of this type. */
export function parseStyleFileName(type: GarmentType, file: string): { side: Side; match: StyleChoice } | null {
  const parts = file.replace(/\.jpg$/, "").split("--");
  const side = parts[0];
  if ((side !== "front" && side !== "back") || !file.endsWith(".jpg")) return null;
  const groups = pictureGroups(type, side);
  const values = parts.slice(1);
  if (values.length !== groups.length || !values.every((v) => SAFE_ID.test(v))) return null;
  return { side, match: Object.fromEntries(groups.map((g, i) => [g, values[i] ?? ""])) };
}

/** Every picture a full set needs: each front combination, and each back combination. */
export function styleCombinations(type: GarmentType, options: Partial<Record<StyleGroup, readonly string[]>>): { side: Side; choice: StyleChoice }[] {
  const combine = (groups: readonly StyleGroup[]): StyleChoice[] =>
    groups.reduce<StyleChoice[]>((acc, group) => acc.flatMap((choice) => (options[group] ?? []).map((id) => ({ ...choice, [group]: id }))), [{}]);
  return [
    ...combine(pictureGroups(type, "front")).map((choice) => ({ side: "front" as const, choice })),
    ...combine(pictureGroups(type, "back")).map((choice) => ({ side: "back" as const, choice })),
  ];
}

/**
 * The few pictures that add most to an item that only has its catalogue photo (`photoStyle`): its back
 * view in the same style, then fronts that change only the sleeves (the most visible difference), then
 * only the other groups. Never the catalogue photo's own front.
 */
export function mostUsefulPictures(
  type: GarmentType,
  photoStyle: StyleChoice,
  options: Partial<Record<StyleGroup, readonly string[]>>,
  count: number,
): { side: Side; choice: StyleChoice }[] {
  const back = { side: "back" as const, choice: Object.fromEntries(pictureGroups(type, "back").map((g) => [g, photoStyle[g] ?? ""])) };
  const changes = (group: StyleGroup) =>
    (options[group] ?? []).filter((id) => id !== photoStyle[group]).map((id) => ({ side: "front" as const, choice: { ...photoStyle, [group]: id } }));
  const others = styleGroupsOf(type).filter((g) => g !== "sleeveLength");
  return [back, ...changes("sleeveLength"), ...others.flatMap(changes)].slice(0, Math.max(0, count));
}
