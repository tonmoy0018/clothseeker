import { expect, test } from "@playwright/test";
import sharp from "sharp";

import { signUpFreshCustomer } from "./helpers";

// @supabase — needs the local Supabase stack with seed data, plus the worker (started by
// playwright.config.ts locally, with the fake providers).

test.describe("@supabase start a design", () => {
  test("from a dress photo: the design screen opens on a matched dress with the photo", async ({ page }) => {
    test.setTimeout(90_000);
    await signUpFreshCustomer(page);
    await page.goto("/");
    await page.getByRole("link", { name: "Start from a photo or idea" }).click();
    await expect(page.getByRole("heading", { name: "Start a design" })).toBeVisible();

    const photo = await sharp({ create: { width: 500, height: 700, channels: 3, background: "#722f37" } }).jpeg().toBuffer();
    await page.getByLabel("Upload a dress photo").setInputFiles({ name: "dress.jpg", mimeType: "image/jpeg", buffer: photo });
    await expect(page.getByTestId("start-waiting")).toContainText("Matching your photo");
    await expect(page).toHaveURL(/\/customize\/[0-9a-f-]{36}\?design=[0-9a-f-]{36}/, { timeout: 30_000 });
    const info = page.getByTestId("start-info");
    await expect(info).toContainText("We matched your photo to this dress");
    await expect(info.getByRole("img", { name: "Your reference photo" })).toBeVisible();
    await expect(info).toContainText("Other good matches");
    // The photo's wine red is applied, so a color is chosen for the skirt.
    await page.getByRole("group", { name: "Part to color" }).getByRole("button", { name: "Skirt", exact: true }).click();
    await expect(page.getByTestId("fabric-grid").getByRole("button", { name: "Wine", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Save design" })).toBeVisible();
  });

  test("from a description: the matched dress opens with four AI ideas on the way", async ({ page }) => {
    test.setTimeout(90_000);
    await signUpFreshCustomer(page);
    await page.goto("/design/start");
    await page.getByLabel("Describe the dress").fill("A linen wrap dress in emerald for a garden party");
    await page.getByRole("button", { name: "Find my dress" }).click();
    await expect(page).toHaveURL(/\/customize\/[0-9a-f-]{36}\?design=[0-9a-f-]{36}&job=[0-9a-f-]{36}/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Design your Linen Wrap Dress" })).toBeVisible();
    await expect(page.getByTestId("start-info")).toContainText("We matched your description to this dress");
    const box = page.getByTestId("ai-box");
    await expect(box.getByTestId("ai-option")).toHaveCount(4, { timeout: 30_000 });
    await expect(page.getByTestId("ai-quota")).toHaveText("9 of 10 AI rounds left today");
  });

  test("brand names in a description are refused with the exact message", async ({ page }) => {
    await signUpFreshCustomer(page);
    await page.goto("/design/start");
    await page.getByLabel("Describe the dress").fill("Exactly like the Zara linen dress");
    await page.getByRole("button", { name: "Find my dress" }).click();
    await expect(page.getByTestId("start-error")).toHaveText("Clothing brand logos can't be used. Try your own logo or another image.");
  });
});
