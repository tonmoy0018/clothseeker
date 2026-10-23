import { expect, test, type Page } from "@playwright/test";

import { chooseFabric, openDesignTab, signUpFreshCustomer } from "./helpers";

// @supabase — needs the local Supabase stack with seed data (customizable seeded dresses).

const password = process.env.SEED_DEMO_PASSWORD ?? "clothseeker-demo";

async function signIn(page: Page, email: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function openLinenDesigner(page: Page) {
  await page.goto("/products/linen-wrap-dress");
  await page.getByRole("link", { name: "Customize this dress" }).click();
  await expect(page).toHaveURL(/\/customize\/[0-9a-f-]{36}/);
  await expect(page.getByRole("heading", { name: "Design your Linen Wrap Dress" })).toBeVisible();
  await expect(page.getByTestId("design-canvas").locator("canvas").first()).toBeVisible();
}

test.describe("@supabase design screen", () => {
  test("customer designs, saves, sees it in My designs and adds it to the cart", async ({ page }) => {
    test.setTimeout(90_000);
    await signUpFreshCustomer(page);
    await openLinenDesigner(page);

    const total = page.getByTestId("design-total");
    const before = await total.textContent();
    await chooseFabric(page, "Skirt", "Emerald");
    await openDesignTab(page, "Personalise");
    await page.getByLabel("New text").fill("Noah's pick");
    await page.getByRole("button", { name: /Add text/ }).click();
    await openDesignTab(page, "Style");
    await page.getByRole("button", { name: /Square/ }).click();
    await expect(page.getByTestId("price-breakdown")).toContainText("Neckline: Square");
    await expect(page.getByTestId("price-breakdown")).toContainText("Text");
    expect(await total.textContent()).not.toBe(before);
    const expectedTotal = (await total.textContent())?.trim() ?? "";

    await page.getByRole("button", { name: "Save design" }).click();
    await expect(page.getByRole("status")).toContainText("Design saved");
    await expect(page).toHaveURL(/\?design=[0-9a-f-]{36}$/);

    await page.getByRole("link", { name: "My designs" }).click();
    await expect(page.getByTestId("design-list")).toContainText("Linen Wrap Dress");
    await expect(page.getByTestId("design-list")).toContainText(expectedTotal);

    // Reopen the saved design and add it to the cart.
    await page.getByTestId("design-list").getByRole("link", { name: /Linen Wrap Dress/ }).first().click();
    await expect(page.getByTestId("price-breakdown")).toContainText("Neckline: Square");
    await page.getByRole("button", { name: "Add to cart" }).click();
    await expect(page).toHaveURL(/\/cart$/);
    const line = page.getByTestId("custom-line").filter({ hasText: "Linen Wrap Dress" });
    await expect(line).toContainText(expectedTotal);
    await expect(page.getByRole("link", { name: "Checkout" })).toBeVisible();

    // Tidy up: deleting the design also removes it from the cart.
    await page.goto("/account/designs");
    page.once("dialog", (dialog) => void dialog.accept());
    const count = await page.getByRole("button", { name: "Delete Linen Wrap Dress design" }).count();
    await page.getByRole("button", { name: "Delete Linen Wrap Dress design" }).first().click();
    await expect(page.getByRole("button", { name: "Delete Linen Wrap Dress design" })).toHaveCount(count - 1);
    // Only check this test's design: other tests may use the same customer's cart in parallel.
    await page.goto("/cart");
    await expect(page.getByTestId("custom-line").filter({ hasText: "Linen Wrap Dress" })).toHaveCount(0);
  });

  test("a signed-out visitor's design survives signing in", async ({ page }) => {
    test.setTimeout(90_000);
    await openLinenDesigner(page);
    await openDesignTab(page, "Personalise");
    await page.getByLabel("New text").fill("Keep me");
    await page.getByRole("button", { name: /Add text/ }).click();
    await page.getByRole("button", { name: "Save design" }).click();

    await expect(page).toHaveURL(/\/login\?next=%2Fcustomize%2F/);
    await signIn(page, "ava@example.test");
    await expect(page).toHaveURL(/\/customize\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("price-breakdown")).toContainText("Text");
    await expect(page.getByText("Unsaved changes").or(page.getByRole("button", { name: "Save design" }))).toBeVisible();
  });

  test("dresses without a live template show a friendly page", async ({ page }) => {
    await page.goto("/customize/11111111-1111-4111-8111-111111111111");
    await expect(page.getByTestId("not-customizable")).toContainText("This dress can't be customized");
  });
});
