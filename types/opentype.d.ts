// Minimal, accurate typings for the parts of opentype.js 2.x that the renderer uses.
// (@types/opentype.js targets 1.x and types getContours() incorrectly.)

declare module "opentype.js" {
  export interface GlyphPoint {
    x: number;
    y: number;
    onCurve: boolean;
    lastPointOfContour?: boolean;
  }

  export interface Glyph {
    name: string | null;
    index: number;
    advanceWidth: number | undefined;
    getContours(): GlyphPoint[][];
  }

  export interface Font {
    unitsPerEm: number;
    ascender: number;
    descender: number;
    charToGlyph(char: string): Glyph;
    getKerningValue(left: Glyph, right: Glyph): number;
  }

  export function parse(buffer: ArrayBuffer): Font;
}
