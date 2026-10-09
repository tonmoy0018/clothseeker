import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";

import { orderCustomDesign, signInAs, signUpFreshCustomer } from "./helpers";

// @supabase — the team's production flow, end to end, as seen by the admin and the customer.

async function qcPhoto() {
  return sharp({ create: { width: 800, height: 1000, channels: 3, background: "#b9a6d9" } }).jpeg().toBuffer();
}

async function uploadQc(admin: Page, side: "front" | "back") {
  const form = admin.locator("form", { has: admin.getByLabel(`Upload ${side} photo`) });
  await form.getByLabel(`Upload ${side} photo`).setInputFiles({ name: `${side}.jpg`, mimeType: "image/jpeg", buffer: await qcPhoto() });
  await form.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(admin.getByRole("img", { name: `QC ${side}` })).toBeVisible();
}

async function step(admin: Page, button: string | RegExp, expectedStatus: string) {
  await admin.getByRole("button", { name: button }).click();
  await expect(admin.getByTestId("item-status")).toHaveText(expectedStatus);
}

test.describe("@supabase production flow", () => {
  test("accept → produce → QC → ship → delivered, with PDFs and customer tracking", async ({ page, browser }) => {
    test.setTimeout(180_000);
    await signUpFreshCustomer(page);
    const orderUrl = await orderCustomDesign(page, { text: "Made for me", note: "Hem 2 cm shorter please" });
    const orderId = new URL(orderUrl).pathname.split("/").pop() ?? "";
    const orderNumber = ((await page.getByRole("heading", { level: 1 }).textContent()) ?? "").match(/CS-\d{8}-[A-Z0-9]{5}/)?.[0] ?? "";

    const admin = await browser.newPage();
    await signInAs(admin, "admin@clothseeker.test", "/admin/orders");
    await expect(admin.getByTestId("order-queue")).toContainText(orderNumber);
    await admin.goto(`/admin/orders/${orderId}`);
    await expect(admin.getByTestId("customer-note")).toHaveText("Hem 2 cm shorter please");

    // The spec sheet is a real PDF; the workshop gets it before production.
    const specHref = (await admin.getByRole("link", { name: "Spec sheet (PDF)" }).getAttribute("href")) ?? "";
    const spec = await admin.request.get(specHref);
    expect(spec.status()).toBe(200);
    expect(spec.headers()["content-type"]).toBe("application/pdf");

    await step(admin, "Accept", "Accepted");
    await step(admin, "Start production", "In production");

    // QC needs both photos.
    await admin.getByRole("button", { name: "Submit for QC" }).click();
    await expect(admin.getByText("Upload a front and a back QC photo")).toBeVisible();
    await uploadQc(admin, "front");
    await uploadQc(admin, "back");
    await step(admin, "Submit for QC", "Quality check");
    await step(admin, "Approve QC", "Ready to ship");
    await step(admin, "Ship with Mock Courier", "Shipped");

    const labelHref = (await admin.getByRole("link", { name: "Shipping label (PDF)" }).getAttribute("href")) ?? "";
    const label = await admin.request.get(labelHref);
    expect(label.headers()["content-type"]).toBe("application/pdf");

    await admin.getByRole("button", { name: "in transit" }).click();
    await expect(admin.getByTestId("shipment")).toContainText("in transit");
    await step(admin, "delivered", "Delivered");

    // The customer sees the journey.
    await page.reload();
    await expect(page.getByTestId("item-progress").locator('[aria-current="step"]')).toHaveText("Delivered");
    await expect(page.getByTestId("tracking")).toContainText(/Mock Courier · tracking MCK[A-Z0-9]{10}/);
    await expect(page.getByTestId("tracking")).toContainText("Delivered");
    await expect(page.getByTestId("order-timeline")).toContainText("Quality check passed");
  });

  test("declining a custom item refunds the customer in full", async ({ page, browser }) => {
    test.setTimeout(150_000);
    await signUpFreshCustomer(page);
    const orderUrl = await orderCustomDesign(page, { text: "Please decline" });
    const orderId = new URL(orderUrl).pathname.split("/").pop() ?? "";

    const admin = await browser.newPage();
    await signInAs(admin, "admin@clothseeker.test", "/admin");
    await admin.goto(`/admin/orders/${orderId}`);
    await admin.getByLabel("Decline reason").fill("This fabric is out of stock");
    await step(admin, "Decline & refund", "Refunded");

    await page.reload();
    await expect(page.getByTestId("order-status")).toHaveText("Refunded");
    await expect(page.getByText("This item was refunded in full: This fabric is out of stock")).toBeVisible();
    await expect(page.getByTestId("refund")).toHaveCount(2); // the item and the delivery fee
  });

  test("customers can't open the order screens or PDFs", async ({ page }) => {
    await signInAs(page, "noah@example.test", "/");
    expect((await page.goto("/admin/orders"))?.status()).toBe(404);
    const pdf = await page.request.get("/admin/orders/11111111-1111-4111-8111-111111111111/items/11111111-1111-4111-8111-111111111111/spec-sheet");
    expect(pdf.status()).toBe(404);
  });
});
