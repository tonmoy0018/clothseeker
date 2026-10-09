import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";

import { signUpFreshCustomer } from "./helpers";

// @supabase — needs the local Supabase stack with seed data. Skipped in CI.

const password = process.env.SEED_DEMO_PASSWORD ?? "clothseeker-demo";

async function signIn(page: Page, email: string, next: string) {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === next.split("?")[0]);
}

test.describe("@supabase admin catalog", () => {
  test("admin creates, stocks, photographs and publishes a dress that a customer can buy", async ({ browser }) => {
    // Long journey across several pages (each compiled on first visit by the dev server).
    test.setTimeout(90_000);
    const adminPage = await browser.newPage();
    const name = `E2E Test Dress ${Date.now()}`;

    await signIn(adminPage, "admin@clothseeker.test", "/admin/products/new");
    await adminPage.getByLabel("Name").fill(name);
    await adminPage.getByLabel("Category").selectOption({ label: "Party" });
    await adminPage.getByLabel("Description").fill("Created by the end-to-end test suite.");
    await adminPage.getByRole("button", { name: "Create draft" }).click();
    await adminPage.waitForURL(/\/admin\/products\/[0-9a-f-]{36}$/);
    const editUrl = adminPage.url();

    // Publishing without a variant is refused.
    await adminPage.getByRole("button", { name: "Publish" }).click();
    await expect(adminPage.getByText("Add at least one active size/color with a price before publishing.")).toBeVisible();

    // Add a size/color.
    await adminPage.getByRole("combobox", { name: "Size", exact: true }).selectOption("M");
    await adminPage.getByLabel("Color name").fill("Coral");
    await adminPage.getByLabel("Price (৳)").fill("2500");
    await adminPage.getByLabel("Stock", { exact: true }).fill("5");
    await adminPage.getByRole("button", { name: "Add", exact: true }).click();
    await expect(adminPage.getByTestId("variant-rows")).toContainText("M · Coral");

    // Upload a photo.
    const png = await sharp({ create: { width: 900, height: 1100, channels: 3, background: "#f28c6f" } }).png().toBuffer();
    await adminPage.getByLabel("Add photo").setInputFiles({ name: "coral.png", mimeType: "image/png", buffer: png });
    await adminPage.getByRole("button", { name: "Upload" }).click();
    await expect(adminPage.getByTestId("photo-grid").getByRole("img")).toHaveCount(1);

    await adminPage.getByRole("button", { name: "Publish" }).click();
    await expect(adminPage.getByRole("link", { name: "View in shop" })).toBeVisible();
    const shopPath = (await adminPage.getByRole("link", { name: "View in shop" }).getAttribute("href")) ?? "";
    expect(shopPath).toMatch(/^\/products\/e2e-test-dress-\d+$/);

    // A customer sees the photo and can buy it.
    const customerPage = await browser.newPage();
    await signUpFreshCustomer(customerPage);
    await customerPage.goto(shopPath);
    await expect(customerPage.getByRole("img", { name })).toBeVisible();
    await expect(async () => {
      await customerPage.getByRole("group", { name: "Size" }).getByRole("button", { name: "M" }).click();
      await expect(customerPage.getByRole("button", { name: "Buy now" })).toBeEnabled({ timeout: 1000 });
    }).toPass();
    await customerPage.getByRole("button", { name: "Buy now" }).click();
    await expect(customerPage).toHaveURL(/\/cart$/);
    const line = customerPage.getByTestId("cart-lines").getByRole("listitem").filter({ hasText: name });
    await expect(line).toContainText("৳2,500 each");

    // Tidy up: remove it from the customer's cart and archive the test dress.
    await line.getByRole("button", { name: "Remove" }).click();
    await expect(line).toHaveCount(0);
    await adminPage.goto(editUrl);
    await adminPage.getByRole("button", { name: "Archive" }).click();
    await expect(adminPage.getByRole("button", { name: "Publish" })).toBeVisible();
  });

  test("admin edits and saves a customization template", async ({ page }) => {
    await signIn(page, "admin@clothseeker.test", "/admin/products");
    await page.getByRole("link", { name: /Linen Wrap Dress/ }).click();
    await page.getByRole("link", { name: "Edit template" }).click();
    await expect(page.getByTestId("placement-canvas").getByRole("img", { name: "Garment" })).toBeVisible();

    const region = `Trim ${Date.now()}`;
    const regionId = region.toLowerCase().replace(" ", "-");
    await expect(page.getByRole("button", { name: "Save template" })).toBeDisabled();
    await page.getByPlaceholder("e.g. Waistband").fill(region);
    await page.getByRole("button", { name: "Add region" }).click();
    await expect(page.getByText("Unsaved changes")).toBeVisible();

    // The template is live, so a recolorable region without a mask is refused…
    await page.getByRole("button", { name: "Save template" }).click();
    await expect(page.getByText(`Upload a mask for: ${region}.`, { exact: false })).toBeVisible();

    // …but saves once it isn't recolorable.
    const newRow = page.locator("div", { has: page.getByText(`id: ${regionId}`, { exact: true }) }).last();
    await newRow.getByRole("checkbox", { name: "Recolorable" }).uncheck();
    await page.getByRole("button", { name: "Save template" }).click();
    await expect(page.getByRole("status")).toContainText(/Saved as version \d+/);

    // The saved region survives a reload; then remove it again so re-runs start clean.
    await page.reload();
    const row = page.locator("div", { has: page.getByText(`id: ${regionId}`, { exact: true }) }).last();
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Remove" }).click();
    await page.getByRole("button", { name: "Save template" }).click();
    await expect(page.getByRole("status")).toContainText(/Saved as version \d+/);
    await page.reload();
    await expect(page.getByText(`id: ${regionId}`, { exact: true })).toHaveCount(0);
  });

  test("customers get 404 on admin pages", async ({ page }) => {
    await signIn(page, "noah@example.test", "/");
    for (const path of ["/admin", "/admin/products", "/admin/products/new"]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);
    }
  });
});
