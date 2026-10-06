import { ShopHeader } from "@/components/shop/shop-header";

export default function ShopLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <ShopHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>
      <footer className="border-t py-6 text-center text-xs text-muted-foreground">
        ClothSeeker — academic prototype. Payments are simulated; no real charges are made.
      </footer>
    </>
  );
}
