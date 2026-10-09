import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical";

export { canonicalJson };

// Deterministic request fingerprints for the AI cache: same inputs ⇒ same hash ⇒ the earlier result
// is reused with no provider call and no quota.

/** Whitespace and letter case don't change what the customer asked for. */
export function normalizeInstruction(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function aiInputHash(input: Record<string, unknown>): string {
  return sha256(canonicalJson(input));
}
