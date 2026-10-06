# Fonts

Fonts available to customers for text layers (`lib/catalog/fonts.ts`). The same files are used by the
browser (`@font-face`) and the server renderer (sharp text `fontfile`), so previews and print files match.

| File | Font | Licence |
|---|---|---|
| inter.ttf | Inter Regular | SIL OFL 1.1 — OFL-inter.txt |
| montserrat.ttf | Montserrat Regular | SIL OFL 1.1 — OFL-montserrat.txt |
| playfair-display.ttf | Playfair Display Regular | SIL OFL 1.1 — OFL-playfairdisplay.txt |
| roboto-slab.ttf | Roboto Slab Regular | Apache 2.0 — LICENSE-robotoslab-apache.txt |
| dancing-script.ttf | Dancing Script Regular | SIL OFL 1.1 — OFL-dancingscript.txt |
| lobster.ttf | Lobster | SIL OFL 1.1 — OFL-lobster.txt |

Source: https://github.com/google/fonts (downloaded 2026-10-06). Embedding in print files is permitted by both licences.

The upstream files are variable fonts. They were converted to static **Regular (wght 400; Inter opsz 14)** instances with
`fonttools varLib.instancer`, and Lobster was re-saved with fontTools, because the server renderer reads glyph outlines
directly (opentype.js applies no variation axes, so Montserrat would otherwise render at its default Thin weight).
To regenerate: `fonttools varLib.instancer <Font>[wght].ttf wght=400 -o <font>.ttf`.
