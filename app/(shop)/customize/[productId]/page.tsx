import { PhasePlaceholder } from "@/components/phase-placeholder";

export default function CustomizePage() {
  return (
    <PhasePlaceholder
      title="Design your dress"
      phase={3}
      features={[
        "Per-part colors and patterns",
        "Text, permitted images and decorations",
        "Neckline, sleeve length and dress length options",
        "Live server-validated price",
      ]}
    />
  );
}
