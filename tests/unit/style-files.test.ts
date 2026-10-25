import { describe, expect, it } from "vitest";

import { defaultTemplateConfig } from "@/lib/catalog/default-template";
import { GARMENT_TYPE_IDS, styleGroupsOf } from "@/lib/catalog/garment-types";
import { parseStyleFileName, pictureGroups, styleCombinations, styleFileName } from "@/lib/garment-photo/style-files";
import { styleOptionsFor } from "@/types/template";

const optionsOf = (type: (typeof GARMENT_TYPE_IDS)[number]) =>
  Object.fromEntries(styleGroupsOf(type).map((g) => [g, styleOptionsFor(defaultTemplateConfig(type), g).map((o) => o.id)]));

describe("style picture files", () => {
  it("names and reads back every picture of every garment type, hyphenated ids included", () => {
    for (const type of GARMENT_TYPE_IDS) {
      for (const { side, choice } of styleCombinations(type, optionsOf(type))) {
        const name = styleFileName(type, side, choice);
        expect(parseStyleFileName(type, name), name).toEqual({ side, match: choice });
      }
    }
    expect(styleFileName("dress", "front", { neckline: "v-neck", sleeveLength: "short", dressLength: "midi" })).toBe("front--v-neck--short--midi.jpg");
    expect(styleFileName("shirt", "back", { collar: "button-down", sleeveLength: "long", fit: "slim" })).toBe("back--long--slim.jpg");
  });

  it("needs every front combination, and backs without the neckline or collar", () => {
    const count = (type: (typeof GARMENT_TYPE_IDS)[number], side: "front" | "back") => styleCombinations(type, optionsOf(type)).filter((j) => j.side === side).length;
    expect([count("dress", "front"), count("dress", "back")]).toEqual([27, 9]);
    expect([count("shirt", "front"), count("shirt", "back")]).toEqual([18, 6]);
    expect([count("panjabi", "front"), count("panjabi", "back")]).toEqual([18, 6]);
    expect(pictureGroups("shirt", "back")).toEqual(["sleeveLength", "fit"]);
  });

  it("ignores files that aren't pictures of this type", () => {
    expect(parseStyleFileName("shirt", "front--v-neck--short--midi.jpg")?.match).toEqual({ collar: "v-neck", sleeveLength: "short", fit: "midi" });
    expect(parseStyleFileName("shirt", "front--classic--long.jpg")).toBeNull();
    expect(parseStyleFileName("dress", "front-round-short-midi.jpg")).toBeNull();
    expect(parseStyleFileName("dress", "notes.txt")).toBeNull();
    expect(parseStyleFileName("dress", "front--../x--short--midi.jpg")).toBeNull();
  });
});
