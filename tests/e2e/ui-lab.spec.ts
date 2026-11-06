// UI lab (/lab): component browser with dummy data. The E2E server sets VERTEX_UI_LAB=on
// (tests/e2e/env.ts); the lab needs no sign-in. Not run locally (browser tests run in CI only).
import { expect, expectHydrated, test } from "./fixtures.ts";

test("lab index lists portal pages by group", async ({ page }) => {
  await page.goto("/lab");
  await expectHydrated(page.locator("[data-lab-frame]"));
  await expect(
    page.getByRole("heading", { level: 1, name: "UI lab" })
  ).toBeVisible();
  await expect(page.locator("[data-lab-group]").first()).toBeVisible();
  await expect(page.locator('[data-lab-entry="charts"]')).toHaveAttribute(
    "href",
    "/lab/charts"
  );
  await expect(page.getByText("Demo data")).toBeVisible();
});

test("charts entry renders the workspace with dummy NVDA data", async ({
  page,
}) => {
  await page.goto("/lab/charts?symbol=NVDA");
  await expectHydrated(page.locator("[data-lab-frame]"));
  await expect(
    page.getByRole("heading", { level: 1, name: "Charts" })
  ).toBeVisible();
  await expect(page.locator('[data-lab-entry-view="charts"]')).toBeVisible();
  await expect(page.getByText("NVDA Demo Listing (fake data)")).toBeVisible();
});
