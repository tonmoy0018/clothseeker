import { LogOut, Menu, Settings2, ShoppingBag, User } from "lucide-react";
import Link from "next/link";

import { signOut } from "@/app/(shop)/_auth/actions";
import { Logo } from "@/components/logo";
import { Button, buttonVariants } from "@/components/ui/button";
import { AUDIENCE_IDS, AUDIENCES } from "@/lib/catalog/garment-types";
import { getCurrentUser } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db";
import { getCartCount } from "@/lib/shop/cart";

const navLink = "rounded-full px-3 py-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground";
const menuLink = "rounded-lg px-3 py-2.5 hover:bg-secondary";

export async function ShopHeader() {
  const user = await getCurrentUser();
  const customer = user?.role === "CUSTOMER";
  const cartCount = customer ? await getCartCount(getPrisma(), user.id) : 0;
  const shopLinks = [
    ...AUDIENCE_IDS.map((audience) => ({ href: `/products?for=${audience}`, label: AUDIENCES[audience].label })),
    { href: "/design/upload", label: "Upload your dress" },
  ];
  const accountLinks = [
    { href: "/account/designs", label: "My designs" },
    { href: "/account/quotes", label: "My quotes" },
    { href: "/account/orders", label: "My orders" },
  ];
  const cart = (
    <Link href="/cart" className={`${navLink} flex items-center gap-1.5`} data-testid="cart-link">
      <ShoppingBag className="size-4" aria-hidden />
      Cart{cartCount > 0 ? ` (${cartCount})` : ""}
    </Link>
  );

  return (
    <header className="border-b bg-background">
      <nav aria-label="Main" className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-4 text-sm">
        <Link href="/" className="mr-4 rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/40">
          <Logo />
        </Link>

        {/* Wide screens: everything in one row. */}
        <div className="hidden items-center gap-1 lg:flex">
          {shopLinks.map((link) => (
            <Link key={link.href} href={link.href} className={navLink}>
              {link.label}
            </Link>
          ))}
        </div>
        <div className="ml-auto hidden items-center gap-1 whitespace-nowrap lg:flex">
          {user?.role === "ADMIN" && (
            <Link href="/admin" className={`${navLink} flex items-center gap-1.5`}>
              <Settings2 className="size-4" aria-hidden />
              Admin
            </Link>
          )}
          {customer && (
            <>
              {accountLinks.map((link) => (
                <Link key={link.href} href={link.href} className={navLink}>
                  {link.label}
                </Link>
              ))}
              {cart}
            </>
          )}
          {user ? (
            <form action={signOut} className="ml-2 flex items-center gap-3 border-l pl-4">
              <span className="flex max-w-40 items-center gap-1.5 truncate text-muted-foreground">
                <User className="size-4 shrink-0" aria-hidden />
                {user.name ?? user.email}
              </span>
              <Button type="submit" variant="outline" size="sm">
                Sign out
              </Button>
            </form>
          ) : (
            <Link href="/login" className={buttonVariants({ variant: "default", size: "sm", className: "ml-2" })}>
              Sign in
            </Link>
          )}
        </div>

        {/* Phones and tablets: the cart, and the rest in a menu that needs no JavaScript. */}
        <div className="ml-auto flex items-center gap-1 lg:hidden">
          {customer && cart}
          <details className="group relative">
            <summary className="flex size-10 cursor-pointer list-none items-center justify-center rounded-full hover:bg-secondary [&::-webkit-details-marker]:hidden" aria-label="Menu">
              <Menu className="size-5" aria-hidden />
            </summary>
            <div className="absolute right-0 z-40 mt-2 flex w-64 flex-col rounded-2xl border bg-card p-2 text-base shadow-lg">
              {shopLinks.map((link) => (
                <Link key={link.href} href={link.href} className={menuLink}>
                  {link.label}
                </Link>
              ))}
              {(customer || user?.role === "ADMIN") && <hr className="my-2" />}
              {user?.role === "ADMIN" && (
                <Link href="/admin" className={menuLink}>
                  Admin
                </Link>
              )}
              {customer &&
                accountLinks.map((link) => (
                  <Link key={link.href} href={link.href} className={menuLink}>
                    {link.label}
                  </Link>
                ))}
              <hr className="my-2" />
              {user ? (
                <form action={signOut} className="flex flex-col gap-2 px-3 py-2">
                  <span className="truncate text-sm text-muted-foreground">{user.name ?? user.email}</span>
                  <Button type="submit" variant="outline" size="sm" className="self-start">
                    <LogOut aria-hidden />
                    Sign out
                  </Button>
                </form>
              ) : (
                <Link href="/login" className={menuLink}>
                  Sign in
                </Link>
              )}
            </div>
          </details>
        </div>
      </nav>
    </header>
  );
}
