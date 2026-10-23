import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AUDIENCES, GARMENT_TYPE_IDS, GARMENT_TYPES, type GarmentType } from "@/lib/catalog/garment-types";

type ProductFieldsProps = {
  categories: { id: string; name: string }[];
  defaults?: { name: string; slug: string; garmentType: GarmentType; categoryId: string; description: string };
  slugOptional?: boolean;
  /** The garment type can't change once the item has a customization template. */
  garmentTypeLocked?: boolean;
};

export function ProductFields({ categories, defaults, slugOptional, garmentTypeLocked }: ProductFieldsProps) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" required maxLength={80} defaultValue={defaults?.name} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="slug">Web address (slug)</Label>
        <Input
          id="slug"
          name="slug"
          maxLength={80}
          required={!slugOptional}
          placeholder={slugOptional ? "Generated from the name" : undefined}
          defaultValue={defaults?.slug}
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
        />
        <p className="text-xs text-muted-foreground">Shown as /products/your-slug. Lowercase letters, numbers, hyphens.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="garmentType">Garment type</Label>
        {garmentTypeLocked && <input type="hidden" name="garmentType" value={defaults?.garmentType} />}
        <select
          id="garmentType"
          name={garmentTypeLocked ? undefined : "garmentType"}
          disabled={garmentTypeLocked}
          defaultValue={defaults?.garmentType ?? "dress"}
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm disabled:opacity-70"
        >
          {GARMENT_TYPE_IDS.map((type) => (
            <option key={type} value={type}>
              {AUDIENCES[GARMENT_TYPES[type].audience].label}&apos;s {GARMENT_TYPES[type].noun}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          {garmentTypeLocked ? "Fixed, because this item has a customization template." : "Decides the style options customers can choose (e.g. neckline or collar)."}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="categoryId">Category</Label>
        <select
          id="categoryId"
          name="categoryId"
          required
          defaultValue={defaults?.categoryId ?? ""}
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
        >
          <option value="" disabled>
            Choose a category
          </option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1.5 md:col-span-2">
        <Label htmlFor="description">Description</Label>
        <textarea
          id="description"
          name="description"
          required
          minLength={10}
          maxLength={2000}
          rows={4}
          defaultValue={defaults?.description}
          className="rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      </div>
    </div>
  );
}
