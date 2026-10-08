import type { Page } from "@playwright/test";

/** Fills the checkout delivery address with valid demo values. */
export async function fillAddress(page: Page) {
  await page.getByLabel("Recipient name").fill("Ava Rahman");
  await page.getByLabel("Mobile number").fill("01712345678");
  await page.getByLabel("Address", { exact: true }).fill("House 12, Road 5, Dhanmondi");
  await page.getByLabel("City / district").fill("Dhaka");
}
