import { SurfaceHeader } from "@/components/surface-header";

const ADMIN_LINKS = [{ href: "/", label: "View shop" }] as const;

// The layout only renders chrome. Authorization lives in each admin page and action
// (requireAdmin), because layouts are not re-checked on every navigation.
export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return (
    <>
      <SurfaceHeader surface="Admin" links={ADMIN_LINKS} />
      <main className="flex-1 px-4 py-10">{children}</main>
    </>
  );
}
