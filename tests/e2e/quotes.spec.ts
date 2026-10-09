import { expect, test } from "@playwright/test";
import sharp from "sharp";

import { fillAddress, signInAs, signUpFreshCustomer } from "./helpers";

// @supabase — needs the local Supabase stack with seed data and the worker (fake providers).

test.describe("@supabase tailoring quotes", () => {
  test("photo design → quote request → team prices it → customer accepts, pays, item starts Accepted", async ({ page, browser }) => {
    test.setTimeout(180_000);
    await signUpFreshCustomer(page);

    // A design started from a dress photo, saved.
    await page.goto("/design/start");
    const photo = await sharp({ create: { width: 500, height: 700, channels: 3, background: "#1f2a44" } }).jpeg().toBuffer();
    await page.getByLabel("Upload a dress photo").setInputFiles({ name: "dress.jpg", mimeType: "image/jpeg", buffer: photo });
    await expect(page).toHaveURL(/\/customize\//, { timeout: 30_000 });
    const quoteBox = page.getByTestId("quote-request");
    await expect(quoteBox).toContainText("Save your design first");
    await page.getByRole("button", { name: "Save design" }).click();
    await expect(page.getByRole("status")).toContainText("Design saved");

    const notes = `High side slit on the left, like my photo (${Date.now()})`;
    await quoteBox.getByLabel("Notes for the tailors").fill(notes);
    await quoteBox.getByRole("button", { name: "Request a tailoring quote" }).click();
    await expect(page).toHaveURL(/\/account\/quotes\/[0-9a-f-]{36}$/);
    const quoteUrl = page.url();
    await expect(page.getByTestId("quote-status")).toHaveText("Waiting for our reply");

    // The team prices it.
    const admin = await browser.newPage();
    await signInAs(admin, "admin@clothseeker.test", "/admin/quotes");
    await admin.getByTestId("admin-quote-list").getByRole("link").filter({ hasText: notes }).click();
    await expect(admin.getByTestId("admin-quote-notes")).toHaveText(notes);
    await expect(admin.getByRole("img", { name: "Customer's reference photo" })).toBeVisible();
    await admin.getByLabel("Price (৳, before delivery)").fill("5200");
    await admin.getByLabel("What the price includes").fill("Includes the side slit and a lined skirt");
    await admin.getByRole("button", { name: "Send price (valid 7 days)" }).click();
    await expect(admin.getByTestId("admin-quote-status")).toHaveText("Price ready");
    await expect(admin.getByText("৳5,200")).toBeVisible();
    await admin.close();

    // The customer accepts and pays.
    await page.goto(quoteUrl);
    await expect(page.getByTestId("quote-status")).toHaveText("Price ready");
    await expect(page.getByTestId("quote-price")).toContainText("৳5,200");
    await page.getByRole("button", { name: "Accept and add to cart" }).click();
    await expect(page).toHaveURL(/\/cart$/);
    await expect(page.getByTestId("quote-line")).toContainText("tailoring quote");
    await expect(page.getByTestId("quote-line")).toContainText("৳5,200");
    await page.getByRole("link", { name: "Checkout" }).click();
    await fillAddress(page);
    await page.getByRole("button", { name: /Place order/ }).click();
    await page.getByRole("button", { name: /^Pay ৳/ }).click();
    await expect(page.getByTestId("order-status")).toHaveText("Paid");
    await expect(page.getByTestId("item-progress").locator('[aria-current="step"]')).toHaveText("Accepted");

    await page.goto(quoteUrl);
    await expect(page.getByTestId("quote-status")).toHaveText("Ordered");
  });
});
