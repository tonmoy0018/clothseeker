// Server code only (reads files from disk). Not marked server-only so unit tests can render.
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse, type Font } from "opentype.js";

import { FONT_IDS, type FontId } from "@/lib/catalog/fonts";

const cache = new Map<FontId, Promise<Font>>();

/** Loads a curated font from public/fonts (same file the browser uses). Cached per process. */
export function loadFont(id: FontId): Promise<Font> {
  if (!FONT_IDS.includes(id)) {
    return Promise.reject(new Error("Unknown font"));
  }
  let font = cache.get(id);
  if (!font) {
    font = readFile(path.join(process.cwd(), "public", "fonts", `${id}.ttf`)).then((buffer) =>
      parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)),
    );
    cache.set(id, font);
  }
  return font;
}
