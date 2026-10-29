import path from "node:path";

import { expect, test } from "@playwright/test";

// On-device vision (live try-on, step 1): the models load from our own site and run in a worker in the
// browser. Runs without seed data or Supabase. Uses one of our own mannequin photos (no person, no face).

test("the on-device models load and analyse a photo in the browser", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const outside: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") outside.push(url.hostname);
  });

  await page.goto("/mirror/check");
  await page.locator('input[type="file"]').setInputFiles(path.join(process.cwd(), "prisma", "seed-photos", "linen-wrap-dress.jpg"));
  await expect(page.getByTestId("vision-status")).toContainText("Running on:", { timeout: 60_000 });
  const stats = page.getByTestId("vision-stats");
  await expect(stats).toBeVisible({ timeout: 60_000 });
  await expect(stats).toContainText("Faces0");
  expect(errors).toEqual([]);
  // Models and runtime come only from our own site.
  expect(outside).toEqual([]);
});
