import { createHash } from "node:crypto";

// Deterministic request fingerprints for the AI cache: same inputs ⇒ same hash ⇒ the earlier result
// is reused with no provider call and no quota.

/** JSON with object keys sorted at every level; `undefined` properties are dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

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
