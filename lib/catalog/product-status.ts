// Which products belong to ClothSeeker's catalogue. A PRIVATE product is a customer's own dress (made from
// their photo, lib/own-dress): the team reaches it only through its quote, never through the catalogue
// screens, so every admin product query is limited to IN_CATALOG.

export const CATALOG_STATUSES = ["DRAFT", "ACTIVE", "ARCHIVED"] as const;
export type CatalogStatus = (typeof CATALOG_STATUSES)[number];

/** Prisma `where` for products in the team's catalogue (not customers' own dresses). */
export const IN_CATALOG = { status: { not: "PRIVATE" } } as const;
