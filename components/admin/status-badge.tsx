import { Badge } from "@/components/ui/badge";
import type { ProductStatus } from "@/lib/generated/prisma/enums";

const LABEL: Record<ProductStatus, string> = { DRAFT: "Draft", ACTIVE: "Live", ARCHIVED: "Archived" };

export function StatusBadge({ status }: { status: ProductStatus }) {
  return (
    <Badge variant={status === "ACTIVE" ? "default" : "secondary"} className={status === "ARCHIVED" ? "opacity-60" : undefined}>
      {LABEL[status]}
    </Badge>
  );
}
