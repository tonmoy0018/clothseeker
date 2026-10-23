import { describe, expect, it } from "vitest";

import { DEFAULT_TEMPLATE_CONFIG } from "@/lib/catalog/default-template";
import { GROUP_ICON, styleIcon } from "@/lib/catalog/style-icons";
import { STYLE_GROUPS } from "@/types/template";

describe("style option drawings", () => {
  it("gives every default option its own drawing", () => {
    for (const group of STYLE_GROUPS) {
      const drawings = DEFAULT_TEMPLATE_CONFIG.styleOptions[group].map((o) => styleIcon(group, o.id).paths.join(" "));
      expect(new Set(drawings).size, group).toBe(drawings.length);
    }
  });

  it("matches option ids by keyword, and falls back to the group's drawing", () => {
    expect(styleIcon("neckline", "deep-v-neck")).toEqual(styleIcon("neckline", "v-neck"));
    expect(styleIcon("sleeveLength", "three-quarter-length")).toEqual(styleIcon("sleeveLength", "three-quarter"));
    expect(styleIcon("sleeveLength", "full")).toEqual(styleIcon("sleeveLength", "long"));
    expect(styleIcon("dressLength", "floor")).toEqual(styleIcon("dressLength", "maxi"));
    expect(styleIcon("neckline", "asymmetric")).toBe(GROUP_ICON.neckline);
  });

  it("draws only finite coordinates inside the 48×48 box", () => {
    const ids = ["round", "v-neck", "square", "sweetheart", "boat", "halter", "off-shoulder", "collar", "sleeveless", "cap", "short", "puff", "elbow", "three-quarter", "long", "mini", "knee", "midi", "maxi"];
    for (const group of STYLE_GROUPS) {
      for (const id of ids) {
        const icon = styleIcon(group, id);
        for (const d of [...icon.paths, ...(icon.dashed ?? [])]) {
          const numbers = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
          expect(numbers.every((n) => Number.isFinite(n) && n >= 0 && n <= 48), `${group}/${id}: ${d}`).toBe(true);
        }
      }
    }
  });
});
