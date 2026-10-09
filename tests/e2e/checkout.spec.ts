import { expect, test, type Page } from "@playwright/test";

import { fillAddress, orderCustomDesign, signUpFreshCustomer } from "./helpers";

// @supabase — needs the local Supabase stack with seed data.

async function buyNow(page: Page, slug: string) {
  await page.goto(`/products/${slug}`);
  await expect(async () => {
    await page.getByRole("group", { name: "Size" }).getByRole("button").and(page.locator(":enabled")).first().click();
    await expect(page.getByRole("button", { name: "Buy now" })).toBeEnabled({ timeout: 1000 });
  }).toPass();
  await page.getByRole("button", { name: "Buy now" }).click();
  await expect(page).toHaveURL(/\/cart$/);
}

async function checkoutToGateway(page: Page) {
  await page.getByRole("link", { name: "Checkout" }).click();
  await fillAddress(page);
  await page.getByRole("button", { name: /Place order/ }).click();
  await expect(page.getByTestId("mock-gateway")).toBeVisible();
}

test.describe("@supabase checkout", () => {
  test("a declined payment cancels the order and keeps the cart", async ({ page }) => {
    test.setTimeout(90_000);
    await signUpFreshCustomer(page);
    await buyNow(page, "floral-sundress");
    await checkoutToGateway(page);

    await page.getByRole("button", { name: "Decline" }).click();
    await expect(page).toHaveURL(/\/account\/orders\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("order-status")).toHaveText("Cancelled");
    await expect(page.getByText("nothing was charged")).toBeVisible();

    await page.goto("/cart");
    const line = page.getByTestId("cart-lines").getByRole("listitem").filter({ hasText: "Floral Sundress" });
    await expect(line).toHaveCount(1);
    await line.getByRole("button", { name: "Remove" }).click();
    await expect(line).toHaveCount(0);
  });

  test("a custom design is paid, frozen with its preview, and waits for acceptance", async ({ page }) => {
    test.setTimeout(120_000);
    await signUpFreshCustomer(page);
    await orderCustomDesign(page, { text: "Order me" });

    const items = page.getByTestId("order-items");
    await expect(items).toContainText("Smocked Cotton Dress — your design");
    await expect(items).toContainText("print file");
    await expect(items.getByRole("img", { name: /Your design for Smocked Cotton Dress/ })).toBeVisible();
    await expect(items.getByTestId("item-progress").locator('[aria-current="step"]')).toHaveText("Awaiting acceptance");
    await expect(page.getByText("ClothSeeker will confirm by")).toBeVisible();
  });
});
