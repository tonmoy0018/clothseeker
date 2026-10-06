import { PhasePlaceholder } from "@/components/phase-placeholder";

export default function HomePage() {
  return (
    <PhasePlaceholder
      title="Shop home"
      phase={1}
      features={[
        "Browse dresses by category",
        "Filter by size, color and price",
        "Product pages with size chart and Buy now",
      ]}
    />
  );
}
