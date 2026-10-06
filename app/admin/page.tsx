import { PhasePlaceholder } from "@/components/phase-placeholder";

export default function AdminHomePage() {
  return (
    <PhasePlaceholder
      title="Admin"
      phase={8}
      features={[
        "Seller approvals",
        "Brand-logo flags and reported listings",
        "Disputes, commission and payouts",
        "AI metrics and audit log",
      ]}
    />
  );
}
