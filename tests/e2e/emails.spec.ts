import { expect, test } from "@playwright/test";

import { fillAddress, signInAs, signUpFreshCustomer } from "./helpers";

// @supabase — needs the local Supabase stack and the worker (started by playwright.config.ts),
// with EMAIL_PROVIDER=smtp → Mailpit (pnpm env:local). Checks the real emails in Mailpit's inbox.

const MAILPIT = "http://127.0.0.1:55424";

test.describe("@supabase customer emails", () => {
  test("an order sends a confirmation and a shipping email to Mailpit", async ({ page, browser, request }) => {
    test.setTimeout(120_000);
    const email = await signUpFreshCustomer(page);
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
    const orderNumber = ((await page.getByRole("heading", { level: 1 }).textContent()) ?? "").match(/CS-\d{8}-[A-Z0-9]{5}/)?.[0] ?? "";
    const orderId = new URL(page.url()).pathname.split("/").pop() ?? "";

    const admin = await browser.newPage();
    await signInAs(admin, "admin@clothseeker.test", "/admin");
    await admin.goto(`/admin/orders/${orderId}`);
    await admin.getByRole("button", { name: "Mark ready to ship" }).click();
    await expect(admin.getByTestId("item-status")).toHaveText("Ready to ship");
    await admin.getByRole("button", { name: "Ship with Mock Courier" }).click();
    await expect(admin.getByTestId("item-status")).toHaveText("Shipped");

    const subjects = async () => {
      const response = await request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
      const body: unknown = await response.json();
      const messages = typeof body === "object" && body !== null && "messages" in body && Array.isArray(body.messages) ? body.messages : [];
      return messages.map((m: unknown) => (typeof m === "object" && m !== null && "Subject" in m ? String(m.Subject) : "")).sort();
    };
    await expect.poll(subjects, { timeout: 30_000 }).toEqual([`Order ${orderNumber} confirmed`, `Your order ${orderNumber} is on its way`].sort());
  });
});
