import { PhasePlaceholder } from "@/components/phase-placeholder";
import { requireAdmin } from "@/lib/auth/guards";

export default async function AdminHomePage() {
  // Server-side guard on every admin page and action; non-admins get a 404.
  await requireAdmin();
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
