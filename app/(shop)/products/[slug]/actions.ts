"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db";
import { addToCart } from "@/lib/shop/cart";
import { ShopError } from "@/lib/shop/errors";

export type BuyNowState = { error?: string };

const slugSchema = z.string().regex(/^[a-z0-9-]{1,80}$/);

function field(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" ? value : undefined;
}

/**
 * Buy now: only product id, size, color and quantity come from the client.
 * The service resolves the variant, checks availability and never accepts a price.
 */
export async function buyNow(_prev: BuyNowState, formData: FormData): Promise<BuyNowState> {
  const slug = slugSchema.safeParse(field(formData, "slug"));
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(slug.success ? `/products/${slug.data}` : "/products")}`);
  }
  if (user.role !== "CUSTOMER") {
    return { error: "Admin accounts can't place orders. Sign in with a customer account to shop." };
  }

  try {
    await addToCart(getPrisma(), user, {
      productId: field(formData, "productId"),
      size: field(formData, "size"),
      color: field(formData, "color"),
      quantity: field(formData, "quantity"),
    });
  } catch (error) {
    if (error instanceof ShopError) {
      return { error: error.message };
    }
    if (error instanceof z.ZodError) {
      return { error: "Choose a size and color first." };
    }
    throw error;
  }
  redirect("/cart");
}
