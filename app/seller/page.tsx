import { PhasePlaceholder } from "@/components/phase-placeholder";

export default function SellerHomePage() {
  return (
    <PhasePlaceholder
      title="Seller portal"
      phase={2}
      features={[
        "Seller onboarding and store profile",
        "Ready-made dresses, variants and inventory",
        "Customizable-template editor",
        "Order queue and production flow (Phase 5)",
      ]}
    />
  );
}
