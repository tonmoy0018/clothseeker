"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { requireUser } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { MockPaymentProvider } from "@/lib/payments/mock";
import { removeCartItem, updateCartItem } from "@/lib/shop/cart";
import { payWithMock } from "@/lib/shop/checkout";
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

export async function payNowAction(_prev: CartActionState, formData: FormData): Promise<CartActionState> {
  const user = await requireUser("/cart");
  let orderNumber: string;
  try {
    const result = await payWithMock(
      getPrisma(),
      user,
      { idempotencyKey: field(formData, "idempotencyKey") ?? "" },
      new MockPaymentProvider(),
    );
    if (result.status !== "PAID") {
      revalidatePath("/cart");
      return { error: "This payment didn't go through. Please review your cart and try again." };
    }
    orderNumber = result.orderNumber;
  } catch (error) {
    revalidatePath("/cart");
    return toState(error);
  }
  redirect(`/account/orders?placed=${encodeURIComponent(orderNumber)}`);
}
