import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ProductFieldsProps = {
  categories: { id: string; name: string }[];
  defaults?: { name: string; slug: string; categoryId: string; description: string };
  slugOptional?: boolean;
};

export function ProductFields({ categories, defaults, slugOptional }: ProductFieldsProps) {
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
