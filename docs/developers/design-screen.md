# Design screen (`/customize/[productId]`)

The customer's configurator, laid out like a tailoring site: a large live preview on the left and the choices in tabs on the right. On phones the preview comes first, the tabs follow, and the size / price / cart bar stays pinned to the bottom.

| Part | File | What it does |
|---|---|---|
| Layout, state, save / cart | `app/(shop)/customize/[productId]/design-editor.tsx` | Holds the `DesignSpec` (the source of truth), undo/redo, the preview and the tabs. All tab panels stay mounted (hidden when inactive), so the AI box keeps polling and nothing resets on a tab switch. |
| Preview | `design-canvas.tsx`, `recolor.ts` | Fabric.js canvas over the recoloured garment picture for the chosen style (`garmentPicture()`, the same choice as the server renderer). For photo templates the picture is the dress's real photo or an AI style picture; when no picture shows the exact style yet, the closest one is used and a note says so. A tool rail has Undo, Redo and See it on me; front/back thumbnails switch sides. |
| Fabric tab | `fabric-tab.tsx` | Pick a part (whole dress or one region), then a fabric tile: the template's plain colours, then each allowed pattern on each colour (printed in the most contrasting allowed colour, adjustable under "Pattern colour"). |
| Style tab | `style-tab.tsx` | A row per group (Neckline, Sleeves, Length) opening into picture tiles with prices. Tiles show the admin's reference image, or a line drawing from `lib/catalog/style-icons.ts` matched by option id. |
| Personalise tab | `personalise-tab.tsx` | Print area, text, decorations and the customer's own image, plus the controls for the item selected on the canvas (picking an item on the canvas opens this tab). |
| AI ideas tab | `ai-box.tsx` | The AI design box ([ai-pipelines.md](ai-pipelines.md)). A design started from a description opens on this tab. |
| Shared pieces | `editor-ui.tsx` | Tiles, accordion rows, swatches, rail buttons, side thumbnails. |

Prices and validation on this screen are previews: the server recomputes both on save, cart and checkout ([design-spec.md](design-spec.md)). A pattern costs its add-on once per part, so a patterned whole dress counts each region.

Browser tests reach the tabs through `openDesignTab()` and fabrics through `chooseFabric()` in `tests/e2e/helpers.ts`.
