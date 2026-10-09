import { expect, test, type Page } from "@playwright/test";

import { signUpFreshCustomer } from "./helpers";

// @supabase — needs the local Supabase stack with seed data, plus the worker (started by
// playwright.config.ts locally, with the fake AI providers). Each test signs up a fresh customer
// so the daily AI quota starts at 10.

const BRAND_MESSAGE = "Clothing brand logos can't be used. Try your own logo or another image.";

async function openDesigner(page: Page) {
  await page.goto("/products/linen-wrap-dress");
  await page.getByRole("link", { name: "Customize this dress" }).click();
  await expect(page.getByRole("heading", { name: "Design your Linen Wrap Dress" })).toBeVisible();
  await expect(page.getByTestId("ai-quota")).toHaveText("10 of 10 AI rounds left today");
}

async function generate(page: Page, instruction: string) {
  const box = page.getByTestId("ai-box");
  await box.getByLabel("Describe your idea").fill(instruction);
  await box.getByRole("button", { name: "Generate 4 ideas" }).click();
}

test.describe("@supabase AI design box", () => {
  test("generate → pick → refine → generate again", async ({ page }) => {
    test.setTimeout(120_000);
    await signUpFreshCustomer(page);
    await openDesigner(page);
    const box = page.getByTestId("ai-box");
    await expect(box).toContainText("Clothing brand logos can't be used.");

    await generate(page, "Make it evening-ready in emerald");
    await expect(box.getByTestId("ai-loading-card")).toHaveCount(4);
    await expect(box.getByTestId("ai-option")).toHaveCount(4, { timeout: 30_000 });
    await expect(page).toHaveURL(/\?design=[0-9a-f-]{36}$/);
    await expect(page.getByTestId("ai-quota")).toHaveText("9 of 10 AI rounds left today");
    // Not saved yet: the AI box only made a hidden draft.
    await expect(page.getByRole("button", { name: "Save design" })).toBeVisible();

    // Picking turns the option into the working design: its colors, style and motif become editable.
    await box.getByRole("button", { name: "Pick option 2" }).click();
    await expect(page.getByRole("status")).toContainText("Applied option 2");
    await expect(page.getByTestId("price-breakdown")).toContainText("Image");
    await expect(page.getByRole("group", { name: "Skirt color", exact: true }).locator('button[aria-pressed="true"]')).not.toHaveAttribute("aria-label", "Original");
    await expect(box.getByRole("button", { name: "Pick option 2" })).toHaveText("Picked");
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByTestId("price-breakdown")).not.toContainText("Image");
    await page.getByRole("button", { name: "Redo" }).click();
    await expect(page.getByTestId("price-breakdown")).toContainText("Image");

    // A follow-up that refers to an option.
    await box.getByRole("button", { name: "Refine option 2" }).click();
    await expect(box.getByTestId("ai-reference")).toHaveText(/Refers to option 2/);
    await box.getByRole("button", { name: "Like option 2 but darker" }).click();
    await box.getByRole("button", { name: "Generate 4 ideas" }).click();
    await expect(box.getByTestId("ai-loading-card")).toHaveCount(4);
    await expect(box.getByTestId("ai-results")).toContainText("Like option 2 but darker", { timeout: 30_000 });
    await expect(box.getByTestId("ai-option")).toHaveCount(4);

    // Generate again: same words, fresh ideas, another round in the history.
    await box.getByRole("button", { name: "Generate again" }).click();
    await expect(box.getByTestId("ai-loading-card")).toHaveCount(4);
    await expect(box.getByTestId("ai-option")).toHaveCount(4, { timeout: 30_000 });
    await expect(page.getByTestId("ai-quota")).toHaveText("7 of 10 AI rounds left today");
    await expect(box.getByTestId("ai-history")).toContainText("Previous rounds (3)");

    // Saving keeps the design (and its rounds) for later.
    await page.getByRole("button", { name: "Save design" }).click();
    await expect(page.getByRole("status")).toContainText("Design saved");
    await page.reload();
    await expect(page.getByTestId("ai-history")).toContainText("Previous rounds (3)");
    await page.getByTestId("ai-history").locator("summary").click();
    await expect(page.getByTestId("ai-history").getByText("Picked 2")).toBeVisible();
  });

  test("brand names are refused with the exact message and cost nothing", async ({ page }) => {
    await signUpFreshCustomer(page);
    await openDesigner(page);
    await generate(page, "add a Nike logo on the chest");
    await expect(page.getByTestId("ai-box").getByRole("alert")).toHaveText(BRAND_MESSAGE);
    await expect(page.getByTestId("ai-quota")).toHaveText("10 of 10 AI rounds left today");
    await expect(page.getByTestId("ai-box").getByTestId("ai-loading-card")).toHaveCount(0);
  });
});
