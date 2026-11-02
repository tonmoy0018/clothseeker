import { readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { chooseFabric, signUpFreshCustomer } from "./helpers";

// @supabase — a customer's own dress from their photo: made exactly as it is, or customised, and priced
// by the team through a quote. Needs the local Supabase stack and the worker (fake AI providers).

/** An AI-generated catalogue photo of a dress on a plain backdrop. */
const dressPhoto = () => readFile(path.join(process.cwd(), "prisma", "seed-photos", "cotton-tiered-midi.jpg"));

async function uploadAndChoose(page: Page, choice: RegExp) {
  await page.goto("/design/start");
  await page.getByLabel("Upload a dress photo").setInputFiles({ name: "my-dress.jpg", mimeType: "image/jpeg", buffer: await dressPhoto() });
  const choices = page.getByTestId("photo-choices");
  await expect(choices).toBeVisible({ timeout: 30_000 });
  await choices.getByRole("button", { name: choice }).click();
  await expect(page).toHaveURL(/\/customize\/[0-9a-f-]{36}\?design=[0-9a-f-]{36}/, { timeout: 60_000 });
}

test.describe("@supabase your own dress", () => {
  test("make this exact dress: see it, try it on, then ask for a price; no shop price or cart", async ({ page }) => {
    test.setTimeout(150_000);
    await signUpFreshCustomer(page);
    await uploadAndChoose(page, /^Make this exact dress/);
    await expect(page.getByRole("heading", { name: "Your dress" }).first()).toBeVisible();
    await expect(page.getByTestId("start-info")).toContainText("This is the dress from your photo");
    await expect(page.getByTestId("own-dress-price")).toContainText("the ClothSeeker team prices it");
    await expect(page.getByTestId("design-total")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add to cart" })).toHaveCount(0);

    // Try it on first.
    await page.getByTestId("own-dress-try-on").getByRole("button", { name: "Try it on" }).click();
    const panel = page.getByTestId("try-on-panel");
    await panel.getByLabel("I agree to use my photo for try-on").check();
    await panel.getByLabel("Upload a photo of me").setInputFiles({ name: "me.jpg", mimeType: "image/jpeg", buffer: await readFile(path.join(process.cwd(), "tests", "fixtures", "tryon-woman.jpg")) });
    await expect(panel.getByRole("radio", { name: "Photo 1" })).toBeVisible();
    await panel.getByRole("button", { name: "Try it on" }).click();
    await expect(panel.getByTestId("try-on-result").getByRole("img", { name: "You wearing this dress (AI preview)" })).toBeVisible({ timeout: 45_000 });

    const quote = page.getByTestId("quote-request");
    await expect(quote).toContainText("Get a price for your dress");
    await quote.getByRole("button", { name: "Request a price" }).click();
    await expect(page).toHaveURL(/\/account\/quotes\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("quote-status")).toHaveText("Waiting for our reply");
  });

  test("customise this dress: recolour it on the photo, save, then ask for a price", async ({ page }) => {
    test.setTimeout(120_000);
    await signUpFreshCustomer(page);
    await uploadAndChoose(page, /^Customize this dress/);
    await expect(page.getByRole("heading", { name: "Your dress" }).first()).toBeVisible();
    await chooseFabric(page, "Skirt", "Emerald");
    const quote = page.getByTestId("quote-request");
    await expect(quote).toContainText("Save your design first");
    await page.getByRole("button", { name: "Save design" }).click();
    await expect(page.getByRole("status")).toContainText("Design saved");
    await quote.getByLabel("Notes for the tailors").fill("Please use a soft cotton.");
    await quote.getByRole("button", { name: "Request a price" }).click();
    await expect(page).toHaveURL(/\/account\/quotes\/[0-9a-f-]{36}$/);

    // Never in the shop.
    await page.goto("/products");
    await expect(page.getByText("Your dress", { exact: true })).toHaveCount(0);
  });
});
