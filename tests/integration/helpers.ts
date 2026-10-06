import { randomUUID } from "node:crypto";

import { afterAll, beforeEach } from "vitest";

import type { Actor } from "@/lib/auth/policy";
import { createPrismaClient } from "@/lib/db/client";
import type { ProductStatus, Role, Size } from "@/lib/generated/prisma/enums";

import { getTestDatabaseUrl } from "./test-env";

export const db = createPrismaClient(getTestDatabaseUrl());

/** Empties every application table before each test in the calling file. */
export function resetDatabaseBeforeEach(): void {
  beforeEach(async () => {
    const tables = await db.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    const list = tables.map((t) => `"public"."${t.tablename}"`).join(", ");
    await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  });
  afterAll(async () => {
    await db.$disconnect();
  });
}

export async function createUser(role: Role = "CUSTOMER"): Promise<Actor> {
  const id = randomUUID();
  await db.user.create({ data: { id, email: `${id}@example.test`, role } });
  return { id, role };
}

type VariantSpec = { size: Size; color: string; priceMinor: number; stock: number; isActive?: boolean };

export async function createProduct(options: {
  slug?: string;
  status?: ProductStatus;
  category?: string;
  variants: VariantSpec[];
}) {
  const categorySlug = options.category ?? "casual";
  const category = await db.category.upsert({
    where: { slug: categorySlug },
    create: { slug: categorySlug, name: categorySlug },
    update: {},
  });
  const slug = options.slug ?? `dress-${randomUUID().slice(0, 8)}`;
  return db.product.create({
    data: {
      slug,
      name: `Dress ${slug}`,
      description: "Test dress",
      categoryId: category.id,
      status: options.status ?? "ACTIVE",
      variants: {
        create: options.variants.map((v) => ({
          sku: `${slug}-${v.size}-${v.color}`,
          size: v.size,
          colorName: v.color,
          colorHex: "#123456",
          priceMinor: v.priceMinor,
          stock: v.stock,
          isActive: v.isActive ?? true,
        })),
      },
    },
    include: { variants: true },
  });
}
