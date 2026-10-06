// Curated pattern library. Templates allow a subset by id; the Phase 3 renderer draws
// each pattern deterministically from this definition (no customer-uploaded patterns).

export const PATTERNS = [
  { id: "stripes", label: "Stripes" },
  { id: "polka-dots", label: "Polka dots" },
  { id: "gingham", label: "Gingham" },
  { id: "floral", label: "Floral" },
  { id: "plaid", label: "Plaid" },
  { id: "chevron", label: "Chevron" },
] as const;

export type PatternId = (typeof PATTERNS)[number]["id"];
export const PATTERN_IDS = PATTERNS.map((p) => p.id) as [PatternId, ...PatternId[]];
