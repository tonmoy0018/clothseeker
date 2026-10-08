import { expect, test, type Page } from "@playwright/test";

import { fillAddress } from "./helpers";

// @supabase — needs the local Supabase stack with seed data.

const password = process.env.SEED_DEMO_PASSWORD ?? "clothseeker-demo";

async function signIn(page: Page, email: string) {
  await page.goto("/login?next=/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => u.pathname === "/");
}

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
    await signIn(page, "mia@example.test");
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
    await signIn(page, "noah@example.test");
    await page.goto("/products/smocked-cotton-dress");
    await page.getByRole("link", { name: "Customize this dress" }).click();
    await expect(page.getByTestId("price-breakdown")).toBeVisible();
    await page.getByTestId("region-skirt").getByRole("button", { name: "Lilac" }).click();
    await page.getByLabel("New text").fill("Order me");
    await page.getByRole("button", { name: /Add text/ }).click();
    const designTotal = (await page.getByTestId("design-total").textContent())?.trim() ?? "";
    await page.getByRole("button", { name: "Add to cart" }).click();
    await expect(page).toHaveURL(/\/cart$/);

    await checkoutToGateway(page);
    await page.getByRole("button", { name: /^Pay ৳/ }).click();

    await expect(page.getByTestId("order-status")).toHaveText("Paid");
    const items = page.getByTestId("order-items");
    await expect(items).toContainText("Smocked Cotton Dress — your design");
    await expect(items).toContainText(designTotal);
    await expect(items).toContainText("print file");
    await expect(items.getByRole("img", { name: /Your design for Smocked Cotton Dress/ })).toBeVisible();
    await expect(items.getByTestId("item-progress").locator('[aria-current="step"]')).toHaveText("Awaiting acceptance");
    await expect(page.getByText("ClothSeeker will confirm by")).toBeVisible();
  });
});
