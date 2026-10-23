import type { StyleGroup } from "@/types/template";

// Line drawings for style options (neckline, sleeves, length), shown on the design screen's picture
// tiles. Pure data: SVG path strings in a 48×48 box, drawn as strokes. Templates can name their options
// freely, so an option id is matched to a drawing by keywords; anything unknown gets the group's
// general drawing. An admin-uploaded reference image always takes precedence over these.

export type StyleIcon = { paths: readonly string[]; dashed?: readonly string[] };

// ─── necklines: the top of a bodice ───────────────────────────────────────────

const bodice = (neck: string): string => `M 9 12 L 18 8 ${neck} L 39 12 Q 37 22 39 30 L 37 44 L 11 44 L 9 30 Q 11 22 9 12 Z`;

const NECKLINES: Record<string, StyleIcon> = {
  round: { paths: [bodice("C 19 19 29 19 30 8")] },
  "v-neck": { paths: [bodice("L 24 25 L 30 8")] },
  square: { paths: [bodice("L 18.5 18 L 29.5 18 L 30 8")] },
  sweetheart: { paths: [bodice("L 18.5 17 Q 21 12.5 24 17 Q 27 12.5 29.5 17 L 30 8")] },
  boat: { paths: [bodice("Q 24 12 30 8")] },
  halter: { paths: ["M 21 6 L 27 6 L 33 16 Q 37 24 38 30 L 36 44 L 12 44 L 10 30 Q 11 24 15 16 Z", "M 21 6 Q 24 16 27 6"] },
  "off-shoulder": { paths: ["M 6 16 Q 24 21 42 16 L 40 22 L 37 44 L 11 44 L 8 22 Z"] },
  collar: { paths: [bodice("C 19 19 29 19 30 8"), "M 18 8 L 16 15 L 23 17", "M 30 8 L 32 15 L 25 17"] },
};

// ─── sleeves: a narrow top with both sleeves ──────────────────────────────────

const TOP = "M 16 12 L 20.5 8.5 C 21.5 14 26.5 14 27.5 8.5 L 32 12 Q 31 22 32 30 L 31 44 L 17 44 L 16 30 Q 17 22 16 12 Z";

/** Both sleeves, `length` units long from the shoulder; `puff` rounds the outer edge. */
function sleevePair(length: number, puff = false): string[] {
  const endX = 16 - 0.3 * length;
  const endY = 12 + length;
  const underarm = Math.min(22, endY);
  // Left sleeve, then the same points mirrored around the centre line (x = 24).
  const sleeve = (m: (x: number) => number) =>
    `M ${m(16)} 12 ` +
    (puff ? `Q ${m(endX - 5)} ${12 + length * 0.3} ${m(endX)} ${endY} ` : `L ${m(endX)} ${endY} `) +
    `L ${m(endX + 5.5)} ${endY + 1.2} L ${m(16.8)} ${underarm}`;
  return [sleeve((x) => x), sleeve((x) => 48 - x)];
}

const SLEEVES: Record<string, StyleIcon> = {
  sleeveless: { paths: [TOP] },
  cap: { paths: [TOP, ...sleevePair(5)] },
  short: { paths: [TOP, ...sleevePair(11)] },
  puff: { paths: [TOP, ...sleevePair(10, true)] },
  elbow: { paths: [TOP, ...sleevePair(18)] },
  "three-quarter": { paths: [TOP, ...sleevePair(24)] },
  long: { paths: [TOP, ...sleevePair(30)] },
};

// ─── lengths: a whole dress, with a dashed knee line for scale ────────────────

const dress = (hem: number, flare: number): string => `M 19 4 L 29 4 L 31 18 L 24 19 L 17 18 Z M 17 18 Q 24 21 31 18 L ${24 + flare} ${hem} Q 24 ${hem + 2} ${24 - flare} ${hem} Z`;
const KNEE = ["M 6 33 L 42 33"];
const LENGTHS: Record<string, StyleIcon> = {
  mini: { paths: [dress(29, 10)], dashed: KNEE },
  knee: { paths: [dress(34, 11)], dashed: KNEE },
  midi: { paths: [dress(39, 12)], dashed: KNEE },
  maxi: { paths: [dress(45, 13)], dashed: KNEE },
};

// ─── matching option ids to drawings ──────────────────────────────────────────

const KEYWORDS: Record<StyleGroup, readonly [RegExp, string][]> = {
  neckline: [
    [/sweetheart/, "sweetheart"],
    [/^v\b|v-?neck|v$/, "v-neck"],
    [/square/, "square"],
    [/boat|bateau/, "boat"],
    [/halter/, "halter"],
    [/off|strapless|bardot/, "off-shoulder"],
    [/collar|shirt|peter/, "collar"],
    [/round|crew|scoop|jewel/, "round"],
  ],
  sleeveLength: [
    [/sleeveless|none|strap|tank/, "sleeveless"],
    [/cap/, "cap"],
    [/puff|balloon/, "puff"],
    [/three|3-4|quarter/, "three-quarter"],
    [/elbow|half/, "elbow"],
    [/long|full|wrist/, "long"],
    [/short/, "short"],
  ],
  dressLength: [
    [/mini|short/, "mini"],
    [/knee/, "knee"],
    [/midi|tea|calf/, "midi"],
    [/maxi|long|floor|ankle|gown/, "maxi"],
  ],
};

const DRAWINGS: Record<StyleGroup, Record<string, StyleIcon>> = { neckline: NECKLINES, sleeveLength: SLEEVES, dressLength: LENGTHS };

/** The general drawing for a group, used on its heading and for options without their own. */
export const GROUP_ICON: Record<StyleGroup, StyleIcon> = {
  neckline: { paths: [bodice("C 19 19 29 19 30 8")] },
  sleeveLength: SLEEVES.short ?? { paths: [] },
  dressLength: { paths: [dress(39, 12)] },
};

export function styleIcon(group: StyleGroup, optionId: string): StyleIcon {
  const match = KEYWORDS[group].find(([pattern]) => pattern.test(optionId));
  return (match && DRAWINGS[group][match[1]]) || GROUP_ICON[group];
}
