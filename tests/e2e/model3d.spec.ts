import { expect, test } from "@playwright/test";

import { signUpFreshCustomer } from "./helpers";

// @supabase — needs the local Supabase stack with seed data, plus the worker (started by
// playwright.config.ts locally, with the fake providers: the model is the garment's picture bulged into a card).

test.describe("@supabase 3D view", () => {
  test("a ready-made item and a design open in 3D; signed-out visitors are asked to sign in", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/products/linen-wrap-dress");
    await page.getByTestId("open-3d-view").click();
    const view = page.getByTestId("garment-3d-view");
    await expect(view.getByRole("button", { name: "Sign in" })).toBeVisible();
    await view.getByRole("button", { name: "Close the 3D view" }).click();
    await expect(view).toBeHidden();

    await signUpFreshCustomer(page);
    await page.goto("/products/linen-wrap-dress");
    await page.getByTestId("open-3d-view").click();
    const model = page.getByTestId("garment-3d-model");
    await expect(model).toBeAttached({ timeout: 60_000 });
    // The viewer fetched and drew the model from its signed link.
    await expect.poll(() => model.evaluate((el) => "loaded" in el && el.loaded === true), { timeout: 30_000 }).toBe(true);
    await page.keyboard.press("Escape");
    await expect(view).toBeHidden();

    await page.getByRole("link", { name: "Customize this dress" }).click();
    await expect(page.getByTestId("design-total")).toBeVisible();
    await page.getByRole("button", { name: "3D view" }).first().click();
    await expect.poll(() => page.getByTestId("garment-3d-model").evaluate((el) => "loaded" in el && el.loaded === true), { timeout: 60_000 }).toBe(true);
  });
});
