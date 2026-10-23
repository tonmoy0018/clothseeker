import { expect, test } from "@playwright/test";
import sharp from "sharp";

import { chooseFabric, signUpFreshCustomer } from "./helpers";

// @supabase — needs the local Supabase stack with seed data, plus the worker (started by
// playwright.config.ts locally, with the fake providers). Fresh customers get a full try-on quota.

async function portraitPhoto(): Promise<Buffer> {
  return sharp({ create: { width: 600, height: 900, channels: 3, background: { r: 150, g: 140, b: 130 } } }).jpeg().toBuffer();
}

test.describe("@supabase virtual try-on", () => {
  test("consent → photo → try-on; a design edit offers Update try-on without rerunning", async ({ page }) => {
    test.setTimeout(120_000);
    await signUpFreshCustomer(page);
    await page.goto("/products/linen-wrap-dress");
    await page.getByRole("link", { name: "Customize this dress" }).click();
    await expect(page.getByTestId("design-total")).toBeVisible();

    await page.getByRole("button", { name: "See it on me" }).click();
    const panel = page.getByTestId("try-on-panel");
    await expect(panel.getByTestId("try-on-quota")).toHaveText("5 of 5 try-ons left today");
    // No upload before consent.
    await expect(panel.getByLabel("Upload a photo of me")).toBeDisabled();
    await expect(panel.getByTestId("try-on-consent")).toContainText("never uses your photos to train AI");
    await panel.getByLabel("I agree to use my photo for try-on").check();
    await panel.getByLabel("Upload a photo of me").setInputFiles({ name: "me.jpg", mimeType: "image/jpeg", buffer: await portraitPhoto() });
    await expect(panel.getByRole("radio", { name: "Photo 1" })).toBeVisible();

    await panel.getByRole("button", { name: "Try it on" }).click();
    await expect(panel.getByTestId("try-on-loading")).toBeVisible();
    const result = panel.getByTestId("try-on-result");
    await expect(result.getByRole("img", { name: "You wearing this dress (AI preview)" })).toBeVisible({ timeout: 30_000 });
    await expect(result.getByRole("img", { name: "Your photo" })).toBeVisible();
    await expect(panel.getByTestId("try-on-quota")).toHaveText("4 of 5 try-ons left today");

    // Editing the design never reruns the try-on by itself.
    await chooseFabric(page, "Skirt", "Emerald");
    await expect(panel.getByTestId("try-on-stale")).toContainText("Your design changed since this try-on.");
    await page.waitForTimeout(2500);
    await expect(panel.getByTestId("try-on-loading")).toHaveCount(0);
    await expect(panel.getByTestId("try-on-quota")).toHaveText("4 of 5 try-ons left today");

    await panel.getByRole("button", { name: "Update try-on" }).click();
    await expect(panel.getByTestId("try-on-loading")).toBeVisible();
    await expect(result.getByRole("img", { name: "You wearing this dress (AI preview)" })).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByTestId("try-on-stale")).toHaveCount(0);
    await expect(panel.getByTestId("try-on-quota")).toHaveText("3 of 5 try-ons left today");

    // Keep the result, then delete the photo: both go at once.
    await result.getByLabel(/Keep this try-on/).check();
    await expect(result.getByLabel(/Keep this try-on/)).toBeChecked();
    await panel.getByRole("button", { name: "Delete photo now" }).click();
    await expect(panel.getByRole("status")).toHaveText("Photo and its try-ons deleted.");
    await expect(panel.getByRole("radio")).toHaveCount(0);
  });

  test("ready-made dresses can be tried on from the product page", async ({ page }) => {
    test.setTimeout(90_000);
    await signUpFreshCustomer(page);
    await page.goto("/products/linen-wrap-dress");
    await page.getByRole("button", { name: "Try on", exact: true }).click();
    const panel = page.getByTestId("try-on-panel");
    await panel.getByLabel("I agree to use my photo for try-on").check();
    await panel.getByLabel("Upload a photo of me").setInputFiles({ name: "me.jpg", mimeType: "image/jpeg", buffer: await portraitPhoto() });
    await panel.getByRole("button", { name: "Try it on" }).click();
    await expect(panel.getByRole("img", { name: "You wearing this dress (AI preview)" })).toBeVisible({ timeout: 30_000 });
  });

  test("signed-out visitors are asked to sign in", async ({ page }) => {
    await page.goto("/products/linen-wrap-dress");
    await page.getByRole("button", { name: "Try on", exact: true }).click();
    await page.getByTestId("try-on-panel").getByRole("button", { name: "Sign in to try on" }).click();
    await expect(page).toHaveURL(/\/login\?next=%2Fproducts%2Flinen-wrap-dress/);
  });
});
