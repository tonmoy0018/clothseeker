import { SurfaceHeader } from "@/components/surface-header";

const SHOP_LINKS = [
  { href: "/cart", label: "Cart" },
  { href: "/account/orders", label: "My orders" },
] as const;

export default function ShopLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <SurfaceHeader surface="Shop" links={SHOP_LINKS} />
      <main className="flex-1 px-4 py-10">{children}</main>
    </>
  );
}
