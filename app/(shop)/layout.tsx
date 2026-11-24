import { ShopFooter } from "@/components/shop/shop-footer";
import { ShopHeader } from "@/components/shop/shop-header";

export default function ShopLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <ShopHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:py-10">{children}</main>
      <ShopFooter />
    </>
  );
}
