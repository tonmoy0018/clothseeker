# DesignSpec

A **DesignSpec** describes one customer's custom dress. It's stored as JSON in `Design.spec`, snapshotted onto `OrderItem.designSpec` at checkout (Phase 4), and rendered into previews and print files.

Schema: [`types/design-spec.ts`](../../types/design-spec.ts) (Zod; TypeScript types are inferred from it). It's versioned: read stored specs with `parseDesignSpec()`.

## Shape (version 1)

| Field | Meaning |
|---|---|
| `productId`, `templateId`, `templateVersion` | The dress and the template version the design was made with |
| `size` | One of the sizes the dress is sold in |
| `styleOptions` | `{ neckline, sleeveLength, dressLength }`: option ids from the template |
| `parts` | `{ [regionId]: { color, pattern?: { id, color } } }`: colors and patterns per recolorable region. Regions not listed keep the garment's own look |
| `layers` | Ordered bottom-to-top; each sits inside one placement area (see below) |
| `startedFrom` | `shop`, `photo` or `description` (photo/description starts arrive in Phase 7) |
| `referencePhotoKey` | Optional reference dress photo (Phase 7) |

### Layers

Every layer has `id`, `areaId`, `x`, `y`, `w`, `h` (fractions of its **placement area**; `x`/`y` is the top-left of the unrotated box) and `rotation` (degrees about the box centre). Then one of:

- `text`: `{ content (≤ 60 printable characters), fontId, color }`
- `image`: `{ assetKey }`, the customer's own upload in the `design-assets` bucket
- `decoration`: `{ id, color }`, from the curated library ([`lib/catalog/decorations.ts`](../../lib/catalog/decorations.ts))

Limits: 30 layers in total, 12 per area.

## Never trusted from the client

The browser builds a spec, but the server **always**:
1. parses it with `parseDesignSpec()` (shape, types, limits)
2. checks it against the **current live template** with `validateDesignAgainstTemplate()` ([`lib/design/validate.ts`](../../lib/design/validate.ts))
3. recomputes the price with `priceDesign()` ([`lib/design/pricing.ts`](../../lib/design/pricing.ts))

### Validation rules

| Rule | Example message |
|---|---|
| Same product and template | "This design belongs to a different dress." |
| Size is sold for this dress | "Size XXL isn't available for this dress." |
| Style options exist | "That style option is no longer available." |
| Parts are recolorable regions; colors and pattern colors are in `allowedColors`; patterns in `allowedPatterns` | "That color isn't available for this dress." |
| Layer areas exist; fonts and decorations are allowed | "That font isn't available for this dress." |
| **Layers stay inside their area, including after rotation** (checked in centimetres, ±0.05 cm) | "An item sticks out of “Front chest”…" |
| Image layers reference **the design owner's own** uploads (`{customerId}/uploads/…`) | "That image isn't one of your uploads." |
| No duplicate layer ids; ≤ 12 layers per area | |

## Pricing

`priceDesign(spec, template, basePriceMinor)` returns line items:

- **Base:** the cheapest active ready-made variant of the dress in the chosen size (`basePriceForSize`).
- **Style options:** each chosen option's add-on, if any.
- **Pattern:** `addOns.patternMinor` × the number of patterned parts.
- **Layers:** `textMinor`, `imageMinor`, `decorationMinor` per layer.

The browser uses the same function for the live price. The server's result is the one that counts.

## Rendering input

`normalizeForRender(spec, template)` ([`lib/design/normalize.ts`](../../lib/design/normalize.ts)) produces the **render plan**. It's the only input to the renderer and has:
- colors lowercased
- geometry rounded (1e-4; rotation 0.1°)
- region fills in template order (not object-key order)
- only regions that have a mask on that side
- print areas = areas that have layers

See [rendering.md](rendering.md).
