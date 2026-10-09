import { expect, type Page } from "@playwright/test";

export const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD ?? "clothseeker-demo";

/** Fills the checkout delivery address with valid demo values. */
export async function fillAddress(page: Page) {
  await page.getByLabel("Recipient name").fill("Ava Rahman");
  await page.getByLabel("Mobile number").fill("01712345678");
  await page.getByLabel("Address", { exact: true }).fill("House 12, Road 5, Dhanmondi");
  await page.getByLabel("City / district").fill("Dhaka");
}

/** Signs in a seeded account and waits until the app lands on `next`. */
export async function signInAs(page: Page, email: string, next = "/") {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => u.pathname === next.split("?")[0]);
}

/**
 * Signs up a brand-new customer. Tests that check out use their own customer, because checkout
 * takes the whole cart and parallel tests would otherwise share one.
 */
export async function signUpFreshCustomer(page: Page): Promise<string> {
  const email = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  await page.goto("/signup");
  await page.getByLabel("Name").fill("E2E Customer");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("e2e-password-123");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL((u) => u.pathname === "/");
  return email;
}

/** Designs a custom Smocked Cotton Dress, adds it to the cart, checks out and pays. Returns the order page URL. */
export async function orderCustomDesign(page: Page, options: { text: string; note?: string }): Promise<string> {
  await page.goto("/products/smocked-cotton-dress");
  await page.getByRole("link", { name: "Customize this dress" }).click();
  await expect(page.getByTestId("price-breakdown")).toBeVisible();
  await page.getByTestId("region-skirt").getByRole("button", { name: "Lilac" }).click();
  await page.getByLabel("New text").fill(options.text);
  await page.getByRole("button", { name: /Add text/ }).click();
  await page.getByRole("button", { name: "Add to cart" }).click();
  await expect(page).toHaveURL(/\/cart$/);
  await page.getByRole("link", { name: "Checkout" }).click();
  await fillAddress(page);
  if (options.note) {
    await page.getByLabel("Notes for our tailors (optional)").fill(options.note);
  }
  await page.getByRole("button", { name: /Place order/ }).click();
  await expect(page.getByTestId("mock-gateway")).toBeVisible();
  await page.getByRole("button", { name: /^Pay ৳/ }).click();
  await expect(page.getByTestId("order-status")).toHaveText("Paid");
  return page.url();
}
