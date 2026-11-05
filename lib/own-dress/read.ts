import { z } from "zod";

import { findBrandTerm } from "@/lib/ai/brands";
import { GARMENT_TYPE_IDS, GARMENT_TYPES, type GarmentType } from "@/lib/catalog/garment-types";

// What the AI reads in a customer's own garment photo (PlannerProvider.readGarment): what it is, where it
// is in the photo, its own parts (each with a box and its main colour), its style, colours and details. The answer is untrusted: it's parsed here, words are
// trimmed and cleared of brand names, and anything unusable is dropped, so a bad answer only means the
// garment is handled as if the AI hadn't been asked (lib/own-dress/build.ts).

const words = (max: number) =>
  z
    .string()
    .transform((s) => s.replace(/\s+/g, " ").trim().slice(0, max))
    // Only plain words (no markup or links), and never a clothing brand.
    .transform((s) => (/^[\p{L}\p{N} ,.'&/()-]*$/u.test(s) && !findBrandTerm(s) ? s : ""));

const optionalWords = (max: number) => words(max).nullish().catch(null);

const rawReadingSchema = z.object({
  garmentType: z.enum([...GARMENT_TYPE_IDS, "other"]).catch("other"),
  name: optionalWords(40),
  description: optionalWords(300),
  /** The main garment's box, 0–1000 of the photo's height and width (Gemini's convention). */
  box: z
    .object({ top: z.number(), left: z.number(), bottom: z.number(), right: z.number() })
    .nullish()
    .catch(null),
  neckline: optionalWords(40),
  sleeves: optionalWords(40),
  length: optionalWords(40),
  colours: z.array(z.object({ name: words(24), hex: z.string().regex(/^#[0-9a-f]{6}$/i) })).max(3).nullish().catch(null),
  pattern: optionalWords(40),
  details: z.array(words(40)).max(5).nullish().catch(null),
  /** The garment's own parts a customer could recolour separately (jacket body, inner shirt, hood…). */
  parts: z
    .array(
      z.object({
        label: words(24),
        box: z.object({ top: z.number(), left: z.number(), bottom: z.number(), right: z.number() }),
        hex: z.string().regex(/^#[0-9a-f]{6}$/i),
      }),
    )
    .max(8)
    .nullish()
    .catch(null),
});

/** At most this many parts, so the Fabric tab stays usable. */
export const MAX_PARTS = 7;

/** A box as fractions (0–1) of the photo. */
export type Box = { top: number; left: number; bottom: number; right: number };

export type GarmentReading = {
  /** Null when it's none of ours (or unsure): the customer's choice, or a dress, is used. */
  garmentType: GarmentType | null;
  /** "Floral tiered midi dress", or null. */
  name: string | null;
  /** What the team should know: the AI's description, then colours, print and details. */
  description: string | null;
  box: Box | null;
  style: { neckline: string | null; sleeves: string | null; length: string | null };
  /** The garment's own parts (2 or more, else none): what each is, where (a box) and its colour. */
  parts: GarmentPart[];
};

export type GarmentPart = { label: string; box: Box; hex: string };

const nonEmpty = (s: string | null | undefined) => (s ? s : null);

/** The AI's reading, checked; null when it isn't a reading at all. */
export function parseGarmentReading(raw: unknown): GarmentReading | null {
  const parsed = rawReadingSchema.safeParse(raw);
  if (!parsed.success) return null;
  const r = parsed.data;
  const f = (v: number) => Math.min(1, Math.max(0, v / 1000));
  const toBox = (b: { top: number; left: number; bottom: number; right: number }): Box => ({ top: f(b.top), left: f(b.left), bottom: f(b.bottom), right: f(b.right) });
  let box: Box | null = null;
  if (r.box) {
    const candidate = toBox(r.box);
    // A garment fills a fair part of a photo; a sliver or an inverted box is no help.
    if (candidate.bottom - candidate.top >= 0.15 && candidate.right - candidate.left >= 0.1) box = candidate;
  }
  // Parts: named, with a box of some size; one name once. Fewer than two parts isn't a split.
  const seen = new Set<string>();
  const parts: GarmentPart[] = [];
  for (const part of r.parts ?? []) {
    const label = part.label;
    const partBox = toBox(part.box);
    if (!label || seen.has(label.toLowerCase()) || partBox.bottom - partBox.top < 0.02 || partBox.right - partBox.left < 0.02) continue;
    seen.add(label.toLowerCase());
    parts.push({ label: `${label.charAt(0).toUpperCase()}${label.slice(1)}`, box: partBox, hex: part.hex.toLowerCase() });
    if (parts.length === MAX_PARTS) break;
  }
  const colours = (r.colours ?? []).map((c) => c.name).filter(Boolean);
  const extras = [
    colours.length > 0 ? `Colours: ${colours.join(", ")}.` : null,
    r.pattern ? `Print or pattern: ${r.pattern}.` : null,
    (r.details ?? []).filter(Boolean).length > 0 ? `Details: ${(r.details ?? []).filter(Boolean).join(", ")}.` : null,
  ].filter((s): s is string => s !== null);
  const description = [nonEmpty(r.description), ...extras].filter((s): s is string => s !== null).join(" ");
  return {
    garmentType: r.garmentType === "other" ? null : r.garmentType,
    name: nonEmpty(r.name),
    description: description ? description.slice(0, 600) : null,
    box,
    style: { neckline: nonEmpty(r.neckline), sleeves: nonEmpty(r.sleeves), length: nonEmpty(r.length) },
    parts: parts.length >= 2 ? parts : [],
  };
}

/** The style word the AI read for a style group (neckline or collar, sleeves, length or fit). */
export function readStyle(reading: GarmentReading | null, group: string): string | null {
  if (!reading) return null;
  if (group === "neckline" || group === "collar") return reading.style.neckline;
  if (group === "sleeveLength") return reading.style.sleeves;
  if (group === "dressLength" || group === "length") return reading.style.length;
  return null;
}

/** "Floral tiered midi dress" → "Your floral tiered midi dress"; no name → "Your dress". */
export function ownDressName(reading: GarmentReading | null, type: GarmentType): string {
  const name = reading?.name;
  if (!name) return `Your ${GARMENT_TYPES[type].noun}`;
  return `Your ${name.charAt(0).toLowerCase()}${name.slice(1)}`.slice(0, 60);
}
