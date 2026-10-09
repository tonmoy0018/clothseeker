// Cheap, local check for clothing brand names in an instruction, before any quota or provider call.
// Deliberately precise: only distinctive brand names, matched as whole words, so ordinary words
// ("puma", "supreme", "champion", "guess", "yellow") never block a customer. Images are checked by
// the planner provider in the worker (lib/ai/worker/design-round.ts).

const BRAND_TERMS = [
  "adidas",
  "nike",
  "gucci",
  "prada",
  "louis vuitton",
  "chanel",
  "dior",
  "versace",
  "zara",
  "h&m",
  "uniqlo",
  "balenciaga",
  "burberry",
  "fendi",
  "hermes",
  "armani",
  "calvin klein",
  "tommy hilfiger",
  "ralph lauren",
  "lacoste",
  "under armour",
  "reebok",
  "new balance",
  "levi's",
  "levis",
  "the north face",
  "off-white",
  "givenchy",
  "valentino",
  "yves saint laurent",
  "ysl",
  "dolce & gabbana",
  "dolce and gabbana",
  "moschino",
  "fila",
  "converse",
  "asics",
  "bershka",
  "shein",
  "aarong",
  "le reve",
  "cat's eye",
];

/** Lowercase, strip accents, unify apostrophes and whitespace. */
function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/\s+/g, " ");
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const PATTERN = new RegExp(`(?<![\\p{L}\\p{N}])(?:${BRAND_TERMS.map((t) => escape(normalize(t))).join("|")})(?![\\p{L}\\p{N}])`, "u");

/** The first clothing brand named in the text, or null. */
export function findBrandTerm(text: string): string | null {
  return PATTERN.exec(normalize(text))?.[0] ?? null;
}
