import { expect, test } from "@playwright/test";

// Phase 0 smoke test: every surface renders and says which phase implements it.
const SURFACES = [
  { path: "/", heading: "Shop home", phase: "Phase 1" },
  { path: "/seller", heading: "Seller portal", phase: "Phase 2" },
  { path: "/admin", heading: "Admin", phase: "Phase 8" },
  { path: "/customize/example", heading: "Design your dress", phase: "Phase 3" },
] as const;

for (const surface of SURFACES) {
  test(`${surface.path} renders its placeholder`, async ({ page }) => {
    await page.goto(surface.path);
    const placeholder = page.getByTestId("phase-placeholder");
    await expect(placeholder).toBeVisible();
    await expect(placeholder.getByText(surface.heading, { exact: true })).toBeVisible();
    await expect(placeholder.getByText(`Coming in ${surface.phase}`)).toBeVisible();
  });
}
