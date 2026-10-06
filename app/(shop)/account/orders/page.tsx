import { PhasePlaceholder } from "@/components/phase-placeholder";

export default function OrdersPage() {
  return (
    <PhasePlaceholder
      title="My orders"
      phase={4}
      features={["Order history", "Order detail and tracking"]}
    />
  );
}
