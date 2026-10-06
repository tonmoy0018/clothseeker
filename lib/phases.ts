// Build phases from CLAUDE.md, used by placeholder pages to show where each feature lands.

export const PHASES = {
  0: "Skeleton",
  1: "Store + auth + roles + Buy Now",
  2: "Seller portal",
  3: "Manual design + renderer",
  4: "Checkout + order splitting",
  5: "Seller production flow",
  6: "AI design box",
  7: "Try-on + photo/description starts + quotes",
  8: "Admin",
  9: "Hardening + deployment",
  10: "Documentation guides",
} as const;

export type PhaseNumber = keyof typeof PHASES;
