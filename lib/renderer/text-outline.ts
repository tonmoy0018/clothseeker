import type { Font, Glyph, GlyphPoint } from "opentype.js";

// Text → SVG outline paths, so text renders identically everywhere without system fonts
// (sharp's text engine needs fontconfig, which serverless hosts don't have).
//
// Glyph outlines are converted directly from TrueType points. opentype.js's own getPath()
// produces NaN for contours that start off-curve in some fonts, so we don't use it.
// No ligatures or contextual substitutions are applied: one glyph per character, plus kerning.

type Point = GlyphPoint;

const round = (v: number) => Math.round(v * 100) / 100;

function contourToPath(points: readonly Point[], tx: (v: number) => number, ty: (v: number) => number): string {
  const n = points.length;
  if (n === 0) {
    return "";
  }
  const firstOn = points.findIndex((p) => p.onCurve);
  let start: { x: number; y: number };
  let order: readonly Point[];
  if (firstOn === -1) {
    // All off-curve: start at the implied midpoint of the first two control points.
    const a = points[0];
    const b = points[1 % n];
    if (!a || !b) {
      return "";
    }
    start = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    order = points;
  } else {
    const s = points[firstOn];
    if (!s) {
      return "";
    }
    start = s;
    order = [...points.slice(firstOn + 1), ...points.slice(0, firstOn)];
  }

  const pt = (x: number, y: number) => `${round(tx(x))} ${round(ty(y))}`;
  let d = `M${pt(start.x, start.y)}`;
  let control: Point | null = null;
  for (const p of order) {
    if (p.onCurve) {
      d += control ? `Q${pt(control.x, control.y)} ${pt(p.x, p.y)}` : `L${pt(p.x, p.y)}`;
      control = null;
    } else {
      if (control) {
        // Two consecutive off-curve points imply an on-curve point halfway between them.
        d += `Q${pt(control.x, control.y)} ${pt((control.x + p.x) / 2, (control.y + p.y) / 2)}`;
      }
      control = p;
    }
  }
  if (control) {
    d += `Q${pt(control.x, control.y)} ${pt(start.x, start.y)}`;
  }
  return `${d}Z`;
}

export type TextOutline = {
  /** SVG path data with the text's left edge at x=0 and its baseline at y=ascent. */
  d: string;
  width: number;
  /** Line height used for layout: ascent + descent at this size. */
  height: number;
  ascent: number;
};

export function textToOutline(font: Font, text: string, fontSize: number): TextOutline {
  const scale = fontSize / font.unitsPerEm;
  const ascent = font.ascender * scale;
  const descent = Math.abs(font.descender) * scale;
  let x = 0;
  let previous: Glyph | null = null;
  const parts: string[] = [];
  for (const char of Array.from(text)) {
    const glyph = font.charToGlyph(char);
    if (previous) {
      x += font.getKerningValue(previous, glyph) * scale;
    }
    const originX = x;
    for (const contour of glyph.getContours()) {
      parts.push(
        contourToPath(
          contour,
          (v) => originX + v * scale,
          (v) => ascent - v * scale,
        ),
      );
    }
    x += (glyph.advanceWidth ?? 0) * scale;
    previous = glyph;
  }
  return { d: parts.join(""), width: x, height: ascent + descent, ascent };
}
