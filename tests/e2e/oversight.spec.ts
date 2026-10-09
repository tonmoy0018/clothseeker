import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";

import { fillAddress, signInAs, signUpFreshCustomer } from "./helpers";

// @supabase — needs the local Supabase stack with seed data (and the worker for the AI pages).

async function buyAndPay(page: Page): Promise<string> {
  await page.goto("/products/floral-sundress");
  await expect(async () => {
    await page.getByRole("group", { name: "Size" }).getByRole("button").and(page.locator(":enabled")).first().click();
    await expect(page.getByRole("button", { name: "Buy now" })).toBeEnabled({ timeout: 1000 });
  }).toPass();
  await page.getByRole("button", { name: "Buy now" }).click();
  await page.getByRole("link", { name: "Checkout" }).click();
  await fillAddress(page);
  await page.getByRole("button", { name: /Place order/ }).click();
  await page.getByRole("button", { name: /^Pay ৳/ }).click();
  await expect(page.getByTestId("order-status")).toHaveText("Paid");
  return page.url();
}

async function step(admin: Page, button: string | RegExp, expectedStatus: string) {
  await admin.getByRole("button", { name: button }).click();
  await expect(admin.getByTestId("item-status")).toHaveText(expectedStatus);
}

test.describe("@supabase admin oversight", () => {
  test("delivered → customer reports a problem with a photo → team refunds → customer sees it", async ({ page, browser }) => {
    test.setTimeout(180_000);
    await signUpFreshCustomer(page);
    const orderUrl = await buyAndPay(page);
    const orderId = new URL(orderUrl).pathname.split("/").pop() ?? "";

    const admin = await browser.newPage();
    await signInAs(admin, "admin@clothseeker.test", "/admin");
    await admin.goto(`/admin/orders/${orderId}`);
    await step(admin, "Mark ready to ship", "Ready to ship");
    await step(admin, "Ship with Mock Courier", "Shipped");
    await step(admin, "delivered", "Delivered");

    // The customer reports a problem.
    await page.reload();
    await page.getByRole("button", { name: "Report a problem" }).click();
    const form = page.getByTestId("report-problem");
    const reason = `The seam on the left side came open on first wear (${Date.now()})`;
    await form.getByLabel("What's wrong?").fill(reason);
    await form.getByLabel("Photos of the problem").setInputFiles({ name: "seam.jpg", mimeType: "image/jpeg", buffer: await sharp({ create: { width: 600, height: 800, channels: 3, background: "#e9c46a" } }).jpeg().toBuffer() });
    await expect(form).toContainText("1 photo(s) ready");
    await form.getByRole("button", { name: "Send to ClothSeeker" }).click();
    await expect(page.getByTestId("dispute")).toContainText("Problem reported");
    await expect(page.getByTestId("order-items")).toContainText("Disputed");

    // The team checks the evidence and refunds.
    await admin.goto("/admin/disputes");
    await admin.getByTestId("dispute-list").getByRole("link").filter({ hasText: reason.slice(0, 30) }).click();
    await expect(admin.getByTestId("dispute-reason")).toHaveText(reason);
    await expect(admin.getByRole("img", { name: "Customer photo 1" })).toBeVisible();
    // The signed photo really loads (not just an empty box).
    await expect.poll(() => admin.getByRole("img", { name: "Customer photo 1" }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await expect(admin.getByTestId("dispute-timeline")).toContainText("Delivered");
    await expect(admin.locator("main")).not.toContainText("01712345678");
    await admin.getByLabel("Note for the customer").fill("Sorry about the seam, we've refunded you in full.");
    await admin.getByRole("button", { name: /^Refund ৳/ }).click();
    await expect(admin.getByTestId("dispute-status")).toHaveText("Refunded");

    // It's in the audit log.
    await admin.goto("/admin/audit?action=dispute.");
    await expect(admin.getByTestId("audit-table")).toContainText("dispute.refunded");
    await expect(admin.getByTestId("audit-table")).toContainText("dispute.opened");

    await page.reload();
    await expect(page.getByTestId("dispute")).toContainText("Problem resolved with a refund");
    await expect(page.getByText("This item was refunded in full")).toBeVisible();
  });

  test("the AI, flags and audit pages render for the team and are hidden from customers", async ({ page, browser }) => {
    const admin = await browser.newPage();
    await signInAs(admin, "admin@clothseeker.test", "/admin");
    await admin.goto("/admin/ai");
    await expect(admin.getByTestId("ai-summary")).toContainText("AI design rounds today");
    await expect(admin.getByTestId("ai-metrics-DESIGN_ROUND")).toContainText("Failure rate");
    await expect(admin.getByTestId("limit-hits")).toBeVisible();
    await admin.goto("/admin/flags");
    await expect(admin.getByRole("heading", { name: "Brand-logo flags" })).toBeVisible();
    await admin.goto("/admin/audit");
    await expect(admin.getByRole("heading", { name: "Audit log" })).toBeVisible();

    await signUpFreshCustomer(page);
    for (const path of ["/admin/ai", "/admin/flags", "/admin/audit", "/admin/disputes"]) {
      expect((await page.goto(path))?.status()).toBe(404);
    }
  });
});
