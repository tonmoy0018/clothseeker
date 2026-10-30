# DesignSpec

A **DesignSpec** describes one customer's custom dress. It's stored as JSON in `Design.spec`, snapshotted onto `OrderItem.designSpec` at checkout (Phase 4), and rendered into previews and print files.

Schema: [`types/design-spec.ts`](../../types/design-spec.ts) (Zod; TypeScript types are inferred from it). It's versioned: read stored specs with `parseDesignSpec()`.

## Shape (version 1)

| Field | Meaning |
|---|---|
| `productId`, `templateId`, `templateVersion` | The dress and the template version the design was made with |
| `size` | One of the sizes the dress is sold in |
| `styleOptions` | The chosen option id for each style group of the template's garment type (e.g. `{ neckline, sleeveLength, dressLength }` for a dress, `{ collar, sleeveLength, fit }` for a shirt). Validated against the live template: every group present, no others |
| `parts` | `{ [regionId]: { color, pattern?: { id, color }, print?: … } }`: per recolorable region, a colour with either a pattern or an **all-over print** (`{ kind: "decoration", id, color, tileCm }` or `{ kind: "image", assetKey, tileCm }`, the motif repeating every `tileCm`, 3–40 cm; never both). Regions not listed keep the garment's own look. An image print must be the customer's own upload; a print is priced like a pattern |
| `layers` | Ordered bottom-to-top; each sits inside one placement area (see below) |
| `startedFrom` | `shop`, `photo` or `description` (photo/description starts arrive in Phase 7) |
| `referencePhotoKey` | Optional reference dress photo (Phase 7) |

### Layers

Every layer has `id`, `areaId`, `x`, `y`, `w`, `h` (fractions of its **placement area**; `x`/`y` is the top-left of the unrotated box) and `rotation` (degrees about the box centre). Then one of:

- `text`: `{ content (≤ 60 printable characters), fontId, color }`
- `image`: `{ assetKey, mirror?, repeat? }`, a file of the customer's own in the `design-assets` bucket: an upload (`uploads/`), an AI motif (`ai/`) or a **decoration cut out of a ClothSeeker dress** (`cutouts/`, see [Cut-outs](#decorations-taken-from-other-dresses)). `mirror` and `repeat` work as for decorations (optional, no version bump).
- `decoration`: `{ id, color }`, from the curated library ([`lib/catalog/decorations.ts`](../../lib/catalog/decorations.ts)). Optional settings (no version bump: absent = the plain look):
  - `detail`: a second colour for the shape's detail (flower centre, bow knot, butterfly body, leaf vein; `hasDetail`); refused on shapes without one.
  - `style: "outline"` with `outline` thickness 2–14, and `mirror: true`.
  - `repeat: { count: 2–24, curve: -1…1 }`: a border of repeats across the box; `curve` > 0 sags into a U (necklines, hems), < 0 arches. The box's own proportions set the spacing (`borderBox`/`borderSpacing`).
  - A design holds at most 80 motifs in total (`MAX_MOTIFS_TOTAL`; decorations and images, a border counts each repeat).

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
| Image layers reference **the design owner's own** files (`{customerId}/uploads/`, `ai/` or `cutouts/`) | "That image isn't one of your uploads." |
| No duplicate layer ids; ≤ 12 layers per area | |

## Pricing

`priceDesign(spec, template, basePriceMinor)` returns line items:

- **Base:** the cheapest active ready-made variant of the dress in the chosen size (`basePriceForSize`).
- **Style options:** each chosen option's add-on, if any.
- **Pattern:** `addOns.patternMinor` × the number of patterned parts.
- **Layers:** `textMinor` per text; `imageMinor` per image motif; `decorationMinor` per decoration motif. A border counts each repeat ("Decoration × 8"; decided 2026-10-30). A cut-out (`cutouts/` key, `isCutoutKey`) is made like a decoration, so it's priced as one.

The browser uses the same function for the live price. The server's result is the one that counts.

## Decorations taken from other dresses

Customers can box a decoration (embroidery, lace, a print) on a photo of any live ClothSeeker product, and the server cuts it out ([`lib/cutouts/`](../../lib/cutouts/)):

- **Cutting** (`cutOutDecoration`, pure apart from sharp):
  - The fabric colours are learned from the box's edges: colours on at least 30% of the edge.
  - Pixels near those colours are keyed out. Tint counts more than lightness, so the cloth's folds go too. `strength` (0–1, default 0.4) sets how much: low keeps fine stitches, high is cleaner.
  - The garment finder's **outline with holes filled** removes the mannequin and backdrop and keeps them out of the fabric colours (a white mannequin would otherwise erase white stitches). If it can't find the garment, the colours alone decide.
  - Specks are dropped, the result is cropped and saved as **lossless** WebP (lossy WebP smears fine stitches).
- **Colours:** up to 4 main colours (`palette`, deterministic for the same photo, box and strength). `swaps` replaces them with colours from the designed product's template, keeping each pixel's shading.
- **Service** (`createCutout`, `listCutouts`, `listCutoutSources`):
  - Customers only; live products only.
  - **30 per Dhaka day**, enforced under a per-customer advisory lock. A refusal records an `AiLimitHit` (`CUTOUT`).
  - Files go to `design-assets/{customerId}/cutouts/`. Each cut (including a colour change) is a new `DecorationCutout` row: source product (and its name, kept if the product is deleted), photo index, settings, size and palette.
- **Production:** the spec sheet names the source dress. When the cut-out has under 150 dpi at its printed size (`printDpi`, `PRINTABLE_DPI`), it says "reference only: recreate it from the original dress, don't print"; catalogue photos usually give a reference rather than a print file.

## Rendering input

`normalizeForRender(spec, template)` ([`lib/design/normalize.ts`](../../lib/design/normalize.ts)) produces the **render plan**. It's the only input to the renderer and has:
- colors lowercased
- geometry rounded (1e-4; rotation 0.1°)
- region fills in template order (not object-key order)
- only regions that have a mask on that side
- print areas = areas that have layers

See [rendering.md](rendering.md).
