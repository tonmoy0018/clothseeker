import path from "node:path";

import { expect, test } from "@playwright/test";

import { signUpFreshCustomer } from "./helpers";

// @supabase — needs seeded products. The browser's fake camera plays tests/fixtures/mirror-woman.mjpeg:
// an AI-generated full-length photo of a person who doesn't exist, standing in front of the camera.

test.use({
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-video-capture=${path.join(process.cwd(), "tests", "fixtures", "mirror-woman.mjpeg")}`,
    ],
  },
});

test.describe("@supabase live mirror", () => {
  test("the garment follows the person on the camera, all on the device; a photo can go to the realistic try-on", async ({ page }) => {
    test.setTimeout(120_000);
    await signUpFreshCustomer(page);
    const outside: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      // blob: and data: URLs (the photo preview) never leave the browser.
      if (url.protocol.startsWith("http") && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") outside.push(url.hostname);
    });

    await page.goto("/products/linen-wrap-dress");
    await page.getByRole("button", { name: "Live mirror" }).click();
    const mirror = page.getByTestId("live-mirror");
    // The camera only starts when asked.
    await expect(mirror).toContainText("See this dress on you, live");
    await mirror.getByRole("button", { name: "Start camera" }).click();
    await expect(page.getByTestId("live-mirror-canvas")).toBeVisible({ timeout: 60_000 });
    // The person is found: no "step back" hint once the models have run for a moment.
    await page.waitForTimeout(3000);
    await expect(page.getByTestId("live-mirror-hint")).toHaveCount(0);

    await mirror.getByRole("button", { name: "Take photo" }).click();
    const capture = page.getByTestId("live-mirror-capture");
    await expect(capture.getByRole("img", { name: "You in this dress (live mirror)" })).toBeVisible();
    await capture.getByRole("button", { name: "Use for the realistic try-on" }).click();
    await expect(mirror).toHaveCount(0);

    // The plain camera photo is offered to the try-on, still only after consent.
    const panel = page.getByTestId("try-on-panel");
    const offer = panel.getByRole("button", { name: "Use my photo from the live mirror" });
    await expect(offer).toBeDisabled();
    await panel.getByLabel("I agree to use my photo for try-on").check();
    await offer.click();
    await expect(panel.getByRole("radio", { name: "Photo 1" })).toBeVisible({ timeout: 60_000 });
    // Models, runtime and the garment picture came only from our own site and storage.
    expect(outside).toEqual([]);
  });
});
