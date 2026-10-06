import { PhasePlaceholder } from "@/components/phase-placeholder";

export default function CartPage() {
  return (
    <PhasePlaceholder
      title="Cart"
      phase={1}
      features={["Ready-made items added with Buy now", "Mock payment (full checkout in Phase 4)"]}
    />
  );
}
