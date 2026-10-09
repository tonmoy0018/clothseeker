import { expect, test, type Page } from "@playwright/test";

import { fillAddress, signUpFreshCustomer } from "./helpers";

// @supabase — needs the local Supabase stack with seed data (`pnpm db:seed`). Skipped in CI.

const password = process.env.SEED_DEMO_PASSWORD ?? "clothseeker-demo";

async function signIn(page: Page, email: string, next = "/") {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.describe("@supabase buy now journey", () => {
  test("customer filters, buys now and sees the paid order", async ({ page }) => {
    // A fresh customer, so test orders never pile up on the demo accounts.
    await signUpFreshCustomer(page);
    await page.goto("/products");

    // Filter: casual dresses in size M.
    await page.getByLabel("Category").selectOption("casual");
    await page.getByLabel("Size").selectOption("M");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(page).toHaveURL(/category=casual/);
    await expect(page.getByRole("heading", { name: "Casual dresses" })).toBeVisible();

    await page.getByTestId("product-card").first().click();
    await expect(page).toHaveURL(/\/products\/[a-z0-9-]+$/);

    // Pick the first in-stock size for the default color.
    const sizeButtons = page.getByRole("group", { name: "Size" }).getByRole("button").and(page.locator(":enabled"));
    // Retry until React has hydrated and the click registers (production pages render before hydration).
    await expect(async () => {
      await sizeButtons.first().click();
      await expect(page.getByTestId("price")).toHaveText(/^৳[\d,]+$/, { timeout: 1000 });
    }).toPass();
    const shownPrice = (await page.getByTestId("price").textContent())?.trim() ?? "";

    await page.getByRole("button", { name: "Buy now" }).click();
    await expect(page).toHaveURL(/\/cart$/);
    await expect(page.getByTestId("cart-lines").getByRole("listitem")).toHaveCount(1);
    await expect(page.getByTestId("cart-total")).toHaveText(shownPrice);

    await page.getByRole("link", { name: "Checkout" }).click();
    await expect(page).toHaveURL(/\/checkout$/);
    await fillAddress(page);
    await page.getByRole("button", { name: /Place order/ }).click();

    await expect(page).toHaveURL(/\/mock-gateway\/mockpay_/);
    await page.getByRole("button", { name: /^Pay ৳/ }).click();

    await expect(page).toHaveURL(/\/account\/orders\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("order-status")).toHaveText("Paid");
    await expect(page.getByTestId("order-timeline")).toContainText("Payment received");
    await page.getByRole("link", { name: "← My orders" }).click();
    await expect(page.getByTestId("order-list")).toContainText("Paid");
  });

  test("another customer cannot see Ava's orders and gets 404 on admin", async ({ page }) => {
    await signIn(page, "noah@example.test", "/account/orders");
    await expect(page).toHaveURL(/\/account\/orders$/);
    await expect(page.getByTestId("order-list").getByText("Ava")).toHaveCount(0);

    const response = await page.goto("/admin");
    expect(response?.status()).toBe(404);
  });

  test("admin signs in to the admin area", async ({ page }) => {
    await signIn(page, "admin@clothseeker.test", "/admin");
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });
});
