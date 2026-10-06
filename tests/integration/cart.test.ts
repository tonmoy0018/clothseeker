import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { ForbiddenError } from "@/lib/auth/policy";
import { addToCart, getCart, removeCartItem, updateCartItem } from "@/lib/shop/cart";
import { ShopError } from "@/lib/shop/errors";

import { createProduct, createUser, db, resetDatabaseBeforeEach } from "./helpers";

resetDatabaseBeforeEach();

async function expectShopError(promise: Promise<unknown>, code: ShopError["code"]) {
  await expect(promise).rejects.toSatisfy((e) => e instanceof ShopError && e.code === code);
}

describe("addToCart", () => {
  it("adds a valid variant priced from the database", async () => {
    const customer = await createUser();
    const product = await createProduct({ variants: [{ size: "M", color: "Sage", priceMinor: 320_000, stock: 5 }] });

    await addToCart(db, customer, { productId: product.id, size: "M", color: "Sage", quantity: 2 });

    const cart = await getCart(db, customer);
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]).toMatchObject({ size: "M", colorName: "Sage", unitPriceMinor: 320_000, quantity: 2 });
    expect(cart.totalMinor).toBe(640_000);
    expect(cart.canCheckout).toBe(true);
  });

  it("ignores any price sent by the client", async () => {
    const customer = await createUser();
    const product = await createProduct({ variants: [{ size: "S", color: "Black", priceMinor: 590_000, stock: 3 }] });

    await addToCart(db, customer, { productId: product.id, size: "S", color: "Black", quantity: 1, priceMinor: 1 });

    expect((await getCart(db, customer)).totalMinor).toBe(590_000);
  });

  it("merges repeated adds into one line", async () => {
    const customer = await createUser();
    const product = await createProduct({ variants: [{ size: "L", color: "Navy", priceMinor: 100_000, stock: 5 }] });

    await addToCart(db, customer, { productId: product.id, size: "L", color: "Navy", quantity: 1 });
    await addToCart(db, customer, { productId: product.id, size: "L", color: "Navy", quantity: 2 });

    const cart = await getCart(db, customer);
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]?.quantity).toBe(3);
  });

  it("rejects products that are not active", async () => {
    const customer = await createUser();
    const draft = await createProduct({
      status: "DRAFT",
      variants: [{ size: "M", color: "Wine", priceMinor: 100_000, stock: 5 }],
    });
    await expectShopError(
      addToCart(db, customer, { productId: draft.id, size: "M", color: "Wine", quantity: 1 }),
      "UNAVAILABLE",
    );
  });

  it("rejects inactive, sold-out and unknown variants", async () => {
    const customer = await createUser();
    const product = await createProduct({
      variants: [
        { size: "M", color: "Sage", priceMinor: 100_000, stock: 5, isActive: false },
        { size: "S", color: "Sage", priceMinor: 100_000, stock: 0 },
      ],
    });
    await expectShopError(
      addToCart(db, customer, { productId: product.id, size: "M", color: "Sage", quantity: 1 }),
      "UNAVAILABLE",
    );
    await expectShopError(
      addToCart(db, customer, { productId: product.id, size: "S", color: "Sage", quantity: 1 }),
      "INSUFFICIENT_STOCK",
    );
    await expectShopError(
      addToCart(db, customer, { productId: product.id, size: "XL", color: "Sage", quantity: 1 }),
      "UNAVAILABLE",
    );
    await expectShopError(
      addToCart(db, customer, { productId: product.id, size: "S", color: "Purple", quantity: 1 }),
      "UNAVAILABLE",
    );
  });

  it("rejects quantities above stock, above the cap, or malformed input", async () => {
    const customer = await createUser();
    const product = await createProduct({ variants: [{ size: "M", color: "Sage", priceMinor: 100_000, stock: 2 }] });

    await expectShopError(
      addToCart(db, customer, { productId: product.id, size: "M", color: "Sage", quantity: 3 }),
      "INSUFFICIENT_STOCK",
    );
    await expect(
      addToCart(db, customer, { productId: product.id, size: "M", color: "Sage", quantity: 11 }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(addToCart(db, customer, { productId: "not-a-uuid", size: "M", color: "Sage" })).rejects.toBeInstanceOf(
      ZodError,
    );
    await expect(addToCart(db, customer, { productId: product.id, size: "HUGE", color: "Sage" })).rejects.toBeInstanceOf(
      ZodError,
    );
    expect((await getCart(db, customer)).lines).toHaveLength(0);
  });

  it("does not let admins shop", async () => {
    const admin = await createUser("ADMIN");
    const product = await createProduct({ variants: [{ size: "M", color: "Sage", priceMinor: 100_000, stock: 2 }] });
    await expect(
      addToCart(db, admin, { productId: product.id, size: "M", color: "Sage", quantity: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("cart ownership", () => {
  it("customer B cannot change or remove customer A's cart lines", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const product = await createProduct({ variants: [{ size: "M", color: "Sage", priceMinor: 100_000, stock: 5 }] });
    await addToCart(db, alice, { productId: product.id, size: "M", color: "Sage", quantity: 1 });
    const itemId = (await getCart(db, alice)).lines[0]?.itemId ?? "";

    await expectShopError(updateCartItem(db, bob, { itemId, quantity: 4 }), "NOT_FOUND");
    await expectShopError(removeCartItem(db, bob, { itemId }), "NOT_FOUND");

    expect((await getCart(db, bob)).lines).toHaveLength(0);
    expect((await getCart(db, alice)).lines[0]?.quantity).toBe(1);
  });

  it("owner can update and remove their lines", async () => {
    const alice = await createUser();
    const product = await createProduct({ variants: [{ size: "M", color: "Sage", priceMinor: 100_000, stock: 5 }] });
    await addToCart(db, alice, { productId: product.id, size: "M", color: "Sage", quantity: 1 });
    const itemId = (await getCart(db, alice)).lines[0]?.itemId ?? "";

    await updateCartItem(db, alice, { itemId, quantity: 3 });
    expect((await getCart(db, alice)).lines[0]?.quantity).toBe(3);
    await expectShopError(updateCartItem(db, alice, { itemId, quantity: 6 }), "INSUFFICIENT_STOCK");

    await removeCartItem(db, alice, { itemId });
    expect((await getCart(db, alice)).lines).toHaveLength(0);
  });

  it("flags lines whose stock dropped after they were added", async () => {
    const alice = await createUser();
    const product = await createProduct({ variants: [{ size: "M", color: "Sage", priceMinor: 100_000, stock: 5 }] });
    await addToCart(db, alice, { productId: product.id, size: "M", color: "Sage", quantity: 3 });
    await db.variant.updateMany({ where: { productId: product.id }, data: { stock: 1 } });

    const cart = await getCart(db, alice);
    expect(cart.lines[0]?.issue).toBe("Only 1 left");
    expect(cart.canCheckout).toBe(false);
  });
});
