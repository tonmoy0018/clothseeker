import Link from "next/link";

import { Logo } from "@/components/logo";
import { AUDIENCE_IDS, AUDIENCES } from "@/lib/catalog/garment-types";

const COLUMNS = [
  {
    title: "Shop",
    links: [...AUDIENCE_IDS.map((audience) => ({ href: `/products?for=${audience}`, label: AUDIENCES[audience].label })), { href: "/products", label: "All clothing" }],
  },
  {
    title: "Make it yours",
    links: [
      { href: "/design/start", label: "Design from an idea" },
      { href: "/design/upload", label: "Bring your own dress" },
    ],
  },
  {
    title: "Your account",
    links: [
      { href: "/account/orders", label: "Orders" },
      { href: "/account/quotes", label: "Tailoring quotes" },
      { href: "/account/designs", label: "Saved designs" },
    ],
  },
];

export function ShopFooter() {
  return (
    <footer className="mt-16 border-t bg-secondary/50">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_1fr]">
        <div className="flex flex-col gap-3">
          <Logo />
          <p className="max-w-xs text-sm text-muted-foreground">Dresses, shirts and panjabis designed, made and delivered by one team. Choose one as it is, or make it your own.</p>
        </div>
        {COLUMNS.map((column) => (
          <div key={column.title} className="flex flex-col gap-3 text-sm">
            <h3 className="font-medium">{column.title}</h3>
            <ul className="flex flex-col gap-2 text-muted-foreground">
              {column.links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="hover:text-foreground">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="border-t px-4 py-5 text-center text-xs text-muted-foreground">ClothSeeker — academic prototype. Payments are simulated; no real charges are made.</p>
    </footer>
  );
}
