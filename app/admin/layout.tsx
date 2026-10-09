import Link from "next/link";

import { signOut } from "@/app/(shop)/auth-actions";
import { Button } from "@/components/ui/button";

// The layout only renders chrome. Authorization lives in each admin page and action
// (requireAdmin), because layouts are not re-checked on every navigation.
export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return (
    <>
      <header className="border-b bg-muted/40">
        <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 text-sm">
          <Link href="/admin" className="font-semibold">
            ClothSeeker <span className="font-normal text-muted-foreground">· Admin</span>
          </Link>
          <Link href="/admin" className="text-muted-foreground hover:text-foreground">
            Dashboard
          </Link>
          <Link href="/admin/orders" className="text-muted-foreground hover:text-foreground">
            Orders
          </Link>
          <Link href="/admin/quotes" className="text-muted-foreground hover:text-foreground">
            Quotes
          </Link>
          <Link href="/admin/products" className="text-muted-foreground hover:text-foreground">
            Products
          </Link>
          <div className="ml-auto flex items-center gap-4">
            <Link href="/" className="text-muted-foreground hover:text-foreground">
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
    </>
  );
}
