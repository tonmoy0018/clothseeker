"use client";

import { useState } from "react";

import { GROUP_ICON, styleIcon } from "@/lib/catalog/style-icons";
import { formatBDT } from "@/lib/money";
import type { DesignSpec } from "@/types/design-spec";
import { STYLE_GROUPS, type StyleGroup, type TemplateConfig } from "@/types/template";

import { AccordionRow, LineIcon, StylePicture, Tile } from "./editor-ui";

// Style tab: one row per style group (neckline, sleeves, length) that opens into picture tiles.

const GROUP_TITLE: Record<StyleGroup, string> = { neckline: "Neckline", sleeveLength: "Sleeves", dressLength: "Length" };

export function StyleTab(props: {
  config: TemplateConfig;
  spec: DesignSpec;
  imageUrls: Readonly<Record<string, string>>;
  /** The template has style pictures, so the preview follows these choices. */
  previewFollows: boolean;
  onChoose: (group: StyleGroup, optionId: string) => void;
}) {
  const { config, spec } = props;
  const [open, setOpen] = useState<StyleGroup | null>("neckline");

  return (
    <div className="flex flex-col">
      {STYLE_GROUPS.map((group) => {
        const options = config.styleOptions[group];
        const chosen = options.find((o) => o.id === spec.styleOptions[group]);
        return (
          <AccordionRow
            key={group}
            id={`style-${group}`}
            title={GROUP_TITLE[group]}
            value={chosen?.label}
            icon={<LineIcon icon={GROUP_ICON[group]} className="size-8" />}
            open={open === group}
            onToggle={() => setOpen((g) => (g === group ? null : group))}
          >
            <div className="grid grid-cols-3 gap-2.5" role="group" aria-label={GROUP_TITLE[group]}>
              {options.map((option) => {
                const price = option.addOnPriceMinor > 0 ? `+${formatBDT(option.addOnPriceMinor)}` : undefined;
                const imageUrl = option.referenceImageKey ? props.imageUrls[option.referenceImageKey] : undefined;
                return (
                  <Tile
                    key={option.id}
                    label={option.label}
                    price={price}
                    ariaLabel={price ? `${option.label} ${price}` : option.label}
                    selected={spec.styleOptions[group] === option.id}
                    onClick={() => props.onChoose(group, option.id)}
                  >
                    <StylePicture icon={styleIcon(group, option.id)} imageUrl={imageUrl} />
                  </Tile>
                );
              })}
            </div>
          </AccordionRow>
        );
      })}
      {props.previewFollows && <p className="pt-4 text-xs text-muted-foreground">The preview changes shape as you choose.</p>}
    </div>
  );
}
