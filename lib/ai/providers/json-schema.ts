import type { JsonSchema } from "./gemini";

// The planner's answer shapes are written once, in Gemini's OpenAPI subset (gemini.ts). Local models are
// held to the same shapes by llama.cpp's grammar, which takes standard JSON Schema: this turns one into
// the other.

const TYPES: Record<string, string> = { OBJECT: "object", ARRAY: "array", STRING: "string", NUMBER: "number", INTEGER: "integer", BOOLEAN: "boolean" };

/** Free text is cut at this length: a small model that starts rambling is stopped by the grammar. */
const MAX_STRING = 240;

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: "null" }] });

/**
 * Standard JSON Schema for a Gemini-subset schema, written for a grammar:
 * - every property is required, in `propertyOrdering` (the grammar writes them in that order, so a
 *   summary that comes last describes what was actually written); one that was optional may be null;
 * - nothing but the listed properties is allowed;
 * - free text has a length limit, and whole-number ranges (0–1000 coordinates) are integers.
 * Pass the answer through `stripNulls`, so "null" means "left out" as it does for Gemini.
 */
export function toJsonSchema(schema: JsonSchema): JsonSchema {
  const type = typeof schema.type === "string" ? (TYPES[schema.type] ?? schema.type.toLowerCase()) : "string";
  let out: JsonSchema;
  if (type === "object") {
    const properties = isSchema(schema.properties) ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === "string") : []);
    const order = Array.isArray(schema.propertyOrdering) ? schema.propertyOrdering.filter((k): k is string => typeof k === "string") : [];
    const keys = [...order.filter((k) => k in properties), ...Object.keys(properties).filter((k) => !order.includes(k))];
    const converted: Record<string, JsonSchema> = {};
    for (const key of keys) {
      const property = properties[key];
      if (!isSchema(property)) continue;
      const inner = toJsonSchema(property);
      // Already nullable ones carry their own "or null".
      converted[key] = required.has(key) || property.nullable === true ? inner : nullable(inner);
    }
    out = { type: "object", properties: converted, required: Object.keys(converted), additionalProperties: false };
  } else if (type === "array") {
    out = { type: "array", items: isSchema(schema.items) ? toJsonSchema(schema.items) : {} };
    for (const key of ["minItems", "maxItems"] as const) if (typeof schema[key] === "number") out[key] = schema[key];
  } else if (type === "string") {
    out = Array.isArray(schema.enum) ? { type: "string", enum: schema.enum } : { type: "string", maxLength: MAX_STRING };
  } else if (type === "number" || type === "integer") {
    const { minimum, maximum } = schema;
    const whole = typeof minimum === "number" && typeof maximum === "number" && Number.isInteger(minimum) && Number.isInteger(maximum);
    out = whole ? { type: "integer", minimum, maximum } : { type };
  } else {
    out = { type };
  }
  return schema.nullable === true ? nullable(out) : out;
}

/** The value without its null properties, at any depth (null items of arrays are dropped too). */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((item) => item !== null).map(stripNulls);
  if (!isSchema(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) if (inner !== null) out[key] = stripNulls(inner);
  return out;
}
