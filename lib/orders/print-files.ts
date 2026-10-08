import { z } from "zod";

// Shape of OrderItem.printFiles (JSON), frozen at checkout for custom items.

export const storedPrintFileSchema = z.object({
  areaId: z.string(),
  label: z.string(),
  key: z.string(),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  widthCm: z.number().positive(),
  heightCm: z.number().positive(),
});

export type StoredPrintFile = z.infer<typeof storedPrintFileSchema>;

export function parsePrintFiles(raw: unknown): StoredPrintFile[] {
  const parsed = z.array(storedPrintFileSchema).safeParse(raw);
  return parsed.success ? parsed.data : [];
}

export function printFileKeys(raw: unknown): string[] {
  return parsePrintFiles(raw).map((f) => f.key);
}
