import type { StyleGroup } from "@/lib/catalog/garment-types";

// A short description of the garment for the try-on model (IDM-VTON reads "model is wearing <this>"
// alongside the garment picture). Detail like the cut, sleeves and length helps it draw the right shape.
// Built only from catalogue words (product name, colour names, style option labels), never from text a
// customer typed, and kept short and plain.

const MAX_LENGTH = 120;

export type GarmentWords = {
  /** e.g. "Linen Wrap Dress" */
  name: string;
  /** What kind of garment it is ("dress", "shirt", "panjabi"), added when the name doesn't say. */
  noun: string;
  /** The main colour's name, e.g. "Navy". */
  colour?: string | null;
  /** Chosen style labels, e.g. ["V-neck", "Short sleeves", "Midi"]. */
  styles?: readonly string[];
  /** The catalogue description (written by the team), for ready-made items. */
  details?: string | null;
};

const GROUP_WORD: Record<StyleGroup, string> = { neckline: "neckline", collar: "collar", sleeveLength: "sleeves", dressLength: "length", length: "length", fit: "fit" };

/** A style choice as words: ("sleeveLength", "Short") → "short sleeves"; ("sleeveLength", "Sleeveless") → "sleeveless". */
export function stylePhrase(group: StyleGroup, label: string): string {
  const word = GROUP_WORD[group];
  const text = label.trim().toLowerCase();
  return text.includes(word.replace(/s$/, "")) ? text : `${text} ${word}`;
}

const clean = (text: string) =>
  text
    .replace(/[^\p{L}\p{N} ,'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

export function garmentDescription(words: GarmentWords): string {
  const name = clean(words.name).toLowerCase();
  const noun = clean(words.noun).toLowerCase();
  const colour = words.colour ? clean(words.colour).toLowerCase() : "";
  const head = [colour, name, name.includes(noun) ? "" : noun].filter(Boolean).join(" ");
  const styles = (words.styles ?? []).map((s) => clean(s).toLowerCase()).filter(Boolean);
  const details = words.details ? clean(words.details.split(/[.;]/)[0] ?? "").toLowerCase() : "";
  const extra = [...styles, details].filter(Boolean);
  const article = /^[aeiou]/.test(head) ? "an" : "a";
  const text = extra.length > 0 ? `${article} ${head}, ${extra.join(", ")}` : `${article} ${head}`;
  return text.length <= MAX_LENGTH ? text : text.slice(0, MAX_LENGTH).replace(/[ ,]+[^ ,]*$/, "");
}
