import Link from "next/link";

import { signOut } from "@/app/(shop)/auth-actions";
import { Button, buttonVariants } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db";
import { getCartCount } from "@/lib/shop/cart";

export async function ShopHeader() {
  const user = await getCurrentUser();
  const cartCount = user?.role === "CUSTOMER" ? await getCartCount(getPrisma(), user.id) : 0;

  return (
    <header className="border-b">
      <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 text-sm">
        <Link href="/" className="text-base font-semibold tracking-tight">
          ClothSeeker
        </Link>
        <Link href="/products" className="text-muted-foreground hover:text-foreground">
          Dresses
        </Link>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-4 gap-y-2 whitespace-nowrap">
          {user?.role === "ADMIN" && (
            <Link href="/admin" className="text-muted-foreground hover:text-foreground">
              Admin
            </Link>
          )}
          {user?.role === "CUSTOMER" && (
            <>
              <Link href="/account/designs" className="text-muted-foreground hover:text-foreground">
                <span className="sm:hidden">Designs</span>
                <span className="hidden sm:inline">My designs</span>
              </Link>
              <Link href="/account/quotes" className="text-muted-foreground hover:text-foreground">
                <span className="sm:hidden">Quotes</span>
                <span className="hidden sm:inline">My quotes</span>
              </Link>
              <Link href="/account/orders" className="text-muted-foreground hover:text-foreground">
                <span className="sm:hidden">Orders</span>
                <span className="hidden sm:inline">My orders</span>
              </Link>
              <Link href="/cart" className="text-muted-foreground hover:text-foreground" data-testid="cart-link">
                Cart{cartCount > 0 ? ` (${cartCount})` : ""}
              </Link>
            </>
          )}
          {user ? (
            <form action={signOut} className="flex items-center gap-3">
              <span className="hidden text-muted-foreground sm:inline">{user.name ?? user.email}</span>
              <Button type="submit" variant="outline" size="sm">
                Sign out
              </Button>
            </form>
          ) : (
            <Link href="/login" className={buttonVariants({ variant: "outline", size: "sm" })}>
              Sign in
            </Link>
          )}
        </div>
      </nav>
    </header>
  );
}
