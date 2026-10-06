import { PhasePlaceholder } from "@/components/phase-placeholder";

export default function AdminHomePage() {
  return (
    <PhasePlaceholder
      title="ClothSeeker admin"
      phase={2}
      features={[
        "Catalog: dresses, variants, inventory and design templates (Phase 2)",
        "Accept custom orders, spec sheets, QC photos and shipping (Phase 5)",
        "Quote requests for special tailoring (Phase 7)",
        "Brand-logo flags, disputes, AI metrics and audit log (Phase 8)",
      ]}
    />
  );
}
