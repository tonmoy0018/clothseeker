import { SurfaceHeader } from "@/components/surface-header";

const ADMIN_LINKS = [{ href: "/", label: "Back to shop" }] as const;

export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return (
    <>
      <SurfaceHeader surface="Admin" links={ADMIN_LINKS} />
      <main className="flex-1 px-4 py-10">{children}</main>
    </>
  );
}
