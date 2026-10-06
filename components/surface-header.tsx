import Link from "next/link";

type NavLink = { href: string; label: string };

type SurfaceHeaderProps = {
  surface: string;
  links: readonly NavLink[];
};

export function SurfaceHeader({ surface, links }: SurfaceHeaderProps) {
  return (
    <header className="border-b">
      <nav className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 text-sm">
        <Link href="/" className="font-semibold">
          ClothSeeker <span className="font-normal text-muted-foreground">· {surface}</span>
        </Link>
        {links.map((link) => (
          <Link key={link.href} href={link.href} className="text-muted-foreground hover:text-foreground">
            {link.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
