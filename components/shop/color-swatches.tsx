import type { ColorSwatch } from "@/lib/shop/catalog";

const HEX = /^#[0-9a-f]{6}$/i;

export function ColorSwatches({ colors }: { colors: readonly ColorSwatch[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Available colors">
      {colors.map((color) => (
        <li
          key={color.name}
          title={color.name}
          className="size-3.5 rounded-full ring-1 ring-black/15"
          style={{ backgroundColor: HEX.test(color.hex) ? color.hex : undefined }}
        >
          <span className="sr-only">{color.name}</span>
        </li>
      ))}
    </ul>
  );
}
