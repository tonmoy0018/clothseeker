import { expect, test } from "@playwright/test";

// Runs without seed data or Supabase Auth (CI uses a plain migrated Postgres).

test("home page renders the shop", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("ClothSeeker");
  await expect(page.getByRole("link", { name: "Shop all dresses" })).toBeVisible();
});

test("product listing renders with filters", async ({ page }) => {
  await page.goto("/products?size=NOPE");
  await expect(page.getByRole("form", { name: "Filter dresses" })).toBeVisible();
  await expect(page.getByTestId("result-count")).toBeVisible();
});

test("unknown product shows a friendly not-found page", async ({ page }) => {
  await page.goto("/products/does-not-exist");
  await expect(page.getByText("This dress isn't available.")).toBeVisible();
});

test("signed-out visitors are sent to sign in from the cart", async ({ page }) => {
  await page.goto("/cart");
  await expect(page).toHaveURL(/\/login\?next=%2Fcart$/);
});

test("admin area is hidden from signed-out visitors", async ({ page }) => {
  const response = await page.goto("/admin");
  expect(response?.status()).toBe(404);
});

test("customize page explains when a dress isn't customizable", async ({ page }) => {
  await page.goto("/customize/example");
  await expect(page.getByTestId("not-customizable")).toBeVisible();
});
