export default function ProductsLoading() {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-3" aria-busy="true" aria-label="Loading dresses">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="aspect-[4/5] animate-pulse rounded-xl bg-muted" />
      ))}
    </div>
  );
}
