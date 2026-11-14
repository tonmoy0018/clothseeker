import Link from "next/link";

import { signOut } from "@/app/(shop)/_auth/actions";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";

const LINKS = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/orders", label: "Orders" },
  { href: "/admin/quotes", label: "Quotes" },
  { href: "/admin/disputes", label: "Disputes" },
  { href: "/admin/flags", label: "Flags" },
  { href: "/admin/ai", label: "AI" },
  { href: "/admin/audit", label: "Audit" },
  { href: "/admin/products", label: "Products" },
];

const navLink = "rounded-full px-3 py-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground";

// The layout only renders chrome. Authorization lives in each admin page and action
// (requireAdmin), because layouts are not re-checked on every navigation.
export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return (
    // data-surface keeps the team's tool in the plain sans face (see globals.css).
    <div data-surface="admin" className="flex flex-1 flex-col">
      <header className="border-b bg-sidebar">
        <nav aria-label="Admin" className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-1 gap-y-2 px-4 py-3 text-sm">
          <Link href="/admin" className="mr-3 rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/40">
            <Logo tag="Admin" />
          </Link>
          {LINKS.map((link) => (
            <Link key={link.href} href={link.href} className={navLink}>
              {link.label}
            </Link>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <Link href="/" className={navLink}>
              View shop
            </Link>
            <form action={signOut}>
              <Button type="submit" variant="outline" size="sm">
                Sign out
              </Button>
            </form>
          </div>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}
