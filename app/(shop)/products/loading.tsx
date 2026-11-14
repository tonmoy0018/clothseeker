export default function ProductsLoading() {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-8 lg:grid-cols-3" aria-busy="true" aria-label="Loading the shop">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="aspect-[4/5] animate-pulse rounded-2xl bg-muted" />
      ))}
    </div>
  );
}
