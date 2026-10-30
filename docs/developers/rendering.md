# Rendering

Server-side renderer: [`lib/renderer/render.ts`](../../lib/renderer/render.ts) (sharp). Its input is always a normalized render plan ([design-spec.md](design-spec.md#rendering-input)), plus assets loaded through the `StorageAdapter`.

## Outputs

| Function | Output | Use |
|---|---|---|
| `renderPreview(plan, side, assets)` | Opaque PNG, 1200 px wide | Design previews (cart, My designs, order pages, spec sheet) |
| `renderFlatGarment(plan, assets, maskKeys)` | Front view, **transparent background** (cut out by the union of region masks) | Virtual try-on input (Phase 7) |
| `renderPrintFiles(plan, assets)` | One **transparent PNG per placement area with layers**, at real size and **300 DPI** (`round(cm / 2.54 × 300)` px; e.g. 20 × 15 cm → 2362 × 1772) | Production |

## How a side is composed

1. **Garment image:** the picture for the design's neckline, sleeve length and dress length (a template's `styleVariants`, picked by `garmentPicture()` in [`lib/design/garment-variant.ts`](../../lib/design/garment-variant.ts)), or the template's own image when no style picture matches. It's resized to the output width. The browser preview uses the same function, so both always show the same picture.
2. **Regions:** for each region the design colors that has a mask on this side, the renderer builds a color image (or the pattern SVG from [`lib/catalog/patterns.ts`](../../lib/catalog/patterns.ts)) whose alpha is the region's mask. With `recolor: "multiply"` (light drawings) it's composited with **`multiply`**, so the garment's own shading, seams and folds show through the new color. With `recolor: "shade"` (photos of any colour) each pixel of the new colour is scaled by the photo's brightness there, stretched between the region's darkest and brightest fabric ([`lib/design/shade.ts`](../../lib/design/shade.ts)), so a navy photo can turn pale pink with its folds intact. The browser preview uses the same functions.
3. **Layers:** each layer is rendered into its box (fractions of the area × the area's pixel size), rotated around its centre with a transparent background, and placed in the area. Layers are drawn bottom to top. A **customised decoration** (second colour, outline, mirror or a border; the render plan then carries `look`/`repeat`) is drawn by `decorationLayerSvg` at the box's own size: a border's motifs follow `repeatLayout` (evenly spaced, sagging into a U or arching, each tilted along the curve). Plain decorations keep their original drawing, so earlier renders are byte-identical. The design screen uses the same SVG. **Images** (uploads and cut-outs) may also be mirrored (`flop`) or repeated as a border (`imageBorder`: the same `repeatLayout`, each copy fitted into its square and tilted); the plan carries `mirror`/`repeat` only when chosen, so plain images are unchanged. The design screen draws them the same way on a canvas (`imageLayerCanvas`).
4. **Printed on the fabric:** the layers are flattened to one full-size RGBA image, then shaped by the garment picture ([`lib/design/fabric-warp.ts`](../../lib/design/fabric-warp.ts)), so text, decorations and images look printed instead of floating flat:
   - **wrap:** along each row of the garment's outline (the union of the picture's region masks, `outlineMaskKeys`, smoothed over ±6% of the height) the print is bent like a partial cylinder (`WRAP` 0.4), so it narrows towards the sides of the body;
   - **folds:** it shifts along the slope of the photo's blurred brightness (a displacement map from the fabric's own creases), at most 1.6% of the width;
   - **light:** its colour is scaled by the fabric's brightness relative to the garment's median (0.42–1.25), so it darkens in folds and shadows.
   Areas that trim to the fabric are trimmed after the shaping. The browser runs the same functions on the canvas, so the design screen and the saved preview match. **Print files stay flat:** the printer prints flat, and the real fabric does the bending.

## All-over prints

A part's `print` repeats a motif (a decoration in a colour, or the customer's image) across the part, like printed fabric. The render plan turns its `tileCm` into a fraction of the picture width with `pictureWidthCm()` (from the placement areas' cm and fractions). The renderer tiles one repeat (the motif fills 70% of it, `PRINT_MOTIF`) over the part's base colour with sharp's `tile` composite, then recolours like a pattern (multiply or shade), so folds show through. The browser does the same with a canvas pattern. Production gets one print file per printed part (`print-<region>`): a single repeat at real size, 300 DPI, labelled with how often it repeats.

## Areas that trim to the fabric

A placement area with `clipToFabric` lets customers put items anywhere in a large box (a whole part or the whole front), and keeps only what lands on the garment: the union of the region masks of the chosen style's picture (`fabricMaskKeys` in the render plan).

- **Previews:** the area's layers are composited on a transparent canvas, their alpha multiplied by that outline, then laid on the garment.
- **Print files:** the outline is cropped to the area and scaled to the print size, so production never prints off the fabric. Large areas lower the DPI so the longest side stays within `MAX_PRINT_SIDE` (6000 px); `printPixels()` returns the DPI used, and the PNG records it.
- **Design screen:** the garment off the fabric (`offFabricOverlay` in `recolor.ts`) is drawn over the items as Fabric's `overlayImage`, so the trim shows live while an item is moved.

## Region masks

A mask is a grayscale image aligned with the garment image: white = the region, black = outside. Admins upload one per region and side in the template editor. Uploads are normalized to single-channel lossless PNG, and transparency counts as black. A recolorable region needs at least one mask before the template can go live. Style pictures carry their own masks, because the regions move when the shape changes.

## Seeded photo templates

The customizable demo items (five dresses, two shirts, two panjabis) are designed on photos ([`prisma/seed-style-photos.ts`](../../prisma/seed-style-photos.ts)):

- **Pictures:** the item's catalogue photo (for the style it shows, `photoStyle` in `prisma/seed-data.ts`, also the design's starting style; made in `photoColor`) plus AI style pictures in `prisma/style-photos/<slug>/`, named by [`lib/garment-photo/style-files.ts`](../../lib/garment-photo/style-files.ts): one option id per style group of the garment type, separated by `--` (`front--v-neck--short--midi.jpg`; backs leave out the neckline or collar: `back--short--midi.jpg`). They come from [`ai-scripts/generate-style-photos.ts`](../../ai-scripts/generate-style-photos.ts).
- **Cutting out** ([`lib/garment-photo/segment.ts`](../../lib/garment-photo/segment.ts)): the background is modelled from the photo's border, the dress colour from its middle, and the dress is what differs from the background and is close to that colour (mannequin and stand trimmed). Sleeves are found by following the body's sides up from the hips: where an edge suddenly moves out, a sleeve starts. The waist is the narrowest torso row (estimated from the shoulder width when long sleeves hide it).
- **Lining up** ([`lib/garment-photo/align.ts`](../../lib/garment-photo/align.ts)): every picture is scaled so the shoulders sit at 6% of the height and, for dresses, the shoulders-to-waist distance is 19%; shirts and panjabis (no clear waist) get a shoulder width of 36% of the picture. Centred, so the body is the same size in all of them. The masks move with the picture.
- **Parts:** dresses are cut into Sleeves, Bodice and Skirt. Shirts and panjabis are one part, Body (the whole garment), because long sleeves hang against the body in their photos and can't be cut apart reliably.
- **Checking:** the generator reads the sleeves and the length back from each AI picture and redraws wrong ones, up to 8 times. Dresses: sleeves from the outline, skirt length relative to the catalogue photo's. Shirts and panjabis: sleeves from the garment's width at mid-height (hanging long sleeves make it wide, `widthAt`), panjabi length relative to the catalogue photo's. Collars, necklines and fit are left to the prompt.
- **Print areas** (`printAreasFor`) cover the whole front, each part (dresses: bodice, skirt, sleeves) and the whole back of every style picture, and trim to the fabric (below).

`tests/unit/garment-photo.test.ts` covers cutting out, sleeve and length reading, and lining up on synthetic photos.

## Seeded garment pictures (drawn)

[`prisma/seed-garments.ts`](../../prisma/seed-garments.ts) draws garments for seeded dresses without a `photoStyle` (and the test fixtures): near-white fabric with soft folds, seams and shadows (multiply keeps them visible under any colour), on a plain `#f3f2ef` background. It draws one picture per neckline × sleeve × length (27 fronts; 9 backs, which ignore the neckline), and each region's mask from exactly the same shapes, so they line up. The regions are Sleeves & straps (`straps`), Bodice and Skirt. `tests/unit/seed-garments.test.ts` checks that every print area stays on the fabric for every style and that regions never overlap. The seed uploads identical images once, and leaves a template that already has style pictures untouched.

## Text without system fonts

Serverless hosts have no fontconfig, and sharp's text engine ignored the font files. Text is therefore converted to **vector outlines** with opentype.js ([`lib/renderer/text-outline.ts`](../../lib/renderer/text-outline.ts)), then rasterized from SVG:

- Fonts are the curated TTFs in `public/fonts/`, the same files the browser loads, as static Regular instances. See `public/fonts/README.md`.
- The renderer converts TrueType contours itself, because opentype.js's `getPath()` emits `NaN` for some fonts.
- Layout is one glyph per character plus kerning, with no ligatures. This is deterministic and fine for short labels. Complex scripts that need shaping (e.g. Bangla conjuncts) aren't supported yet.
- The text is scaled to fit its layer box, keeping its proportions.

## Determinism

The same plan with the same assets produces **byte-identical PNGs**. There's no randomness or timestamps in the output, compression settings are fixed, and geometry is rounded in the plan. Tests in `tests/unit/renderer.test.ts` hash two renders.

For a visual check, run `RENDER_SNAPSHOT_DIR=/tmp/renders pnpm vitest run --project unit tests/unit/renderer.test.ts`. It writes the preview, the flat garment and the print files.

## Notes

- `joinChannel` in sharp is a no-op on generated (`create`) images, so alpha channels are interleaved by hand (`rgbaFrom`).
- Rendering is CPU-heavy (a 35 × 30 cm print file is about 4100 × 3500 px). Previews are rendered when a design is saved; print files are rendered at checkout (Phase 4) or by the worker, never on page views.
