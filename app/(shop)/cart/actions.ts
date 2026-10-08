"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireUser } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { removeCartItem, updateCartItem } from "@/lib/shop/cart";
import { ShopError } from "@/lib/shop/errors";

export type CartActionState = { error?: string };

function field(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" ? value : undefined;
}

function toState(error: unknown): CartActionState {
  if (error instanceof ShopError) {
    return { error: error.message };
  }
  if (error instanceof z.ZodError) {
    return { error: "That request wasn't valid. Please refresh and try again." };
  }
  throw error;
}

export async function updateQuantityAction(_prev: CartActionState, formData: FormData): Promise<CartActionState> {
  const user = await requireUser("/cart");
  try {
    await updateCartItem(getPrisma(), user, {
      itemId: field(formData, "itemId") ?? "",
      quantity: field(formData, "quantity") ?? "",
    });
  } catch (error) {
    return toState(error);
  }
  revalidatePath("/cart");
  return {};
}

export async function removeItemAction(_prev: CartActionState, formData: FormData): Promise<CartActionState> {
  const user = await requireUser("/cart");
  try {
    await removeCartItem(getPrisma(), user, { itemId: field(formData, "itemId") ?? "" });
  } catch (error) {
    return toState(error);
  }
  revalidatePath("/cart");
  return {};
}
