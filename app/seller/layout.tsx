import { SurfaceHeader } from "@/components/surface-header";

const SELLER_LINKS = [{ href: "/", label: "Back to shop" }] as const;

export default function SellerLayout({ children }: LayoutProps<"/seller">) {
  return (
    <>
      <SurfaceHeader surface="Seller portal" links={SELLER_LINKS} />
      <main className="flex-1 px-4 py-10">{children}</main>
    </>
  );
}
