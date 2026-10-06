import Link from "next/link";

export default function ProductNotFound() {
  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border p-8">
      <p className="font-medium">This dress isn&apos;t available.</p>
      <p className="text-sm text-muted-foreground">It may have been removed or is no longer for sale.</p>
      <Link href="/products" className="text-sm underline">
        Browse all dresses
      </Link>
    </div>
  );
}
