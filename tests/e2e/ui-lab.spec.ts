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

test("panel actions wrap inside the panel at 375 px without horizontal scroll after submit", async ({
  page,
}) => {
  await page.setViewportSize({ height: 812, width: 375 });
  await page.goto("/lab/charts");
  await expectHydrated(page.locator("[data-lab-frame]"));
  const chartPanel = page.locator('[data-chart-panel][data-slot="panel"]');
  await expect(chartPanel).toBeVisible();

  const measure = async () =>
    chartPanel.evaluate((section) => {
      const header = section.querySelector<HTMLElement>(
        '[data-slot="panel-header"]'
      );
      const actions = section.querySelector<HTMLElement>(
        '[data-slot="panel-actions"]'
      );
      const sectionRect = section.getBoundingClientRect();
      const actionsRect = actions?.getBoundingClientRect();
      return {
        actionsOverflowRight:
          actionsRect === undefined
            ? 0
            : Math.round(actionsRect.right - sectionRect.right),
        headerOverflow:
          header === null ? 0 : header.scrollWidth - header.clientWidth,
        panelScrollLeft: section.scrollLeft,
      };
    });

  expect(await measure()).toEqual({
    actionsOverflowRight: expect.any(Number),
    headerOverflow: 0,
    panelScrollLeft: 0,
  });
  expect((await measure()).actionsOverflowRight).toBeLessThanOrEqual(0);

  await page.getByRole("button", { exact: true, name: "Open" }).click();
  await expect(page.locator("[data-chart-panel]")).toBeVisible();
  const afterSubmit = await measure();
  expect(afterSubmit.headerOverflow).toBe(0);
  expect(afterSubmit.actionsOverflowRight).toBeLessThanOrEqual(0);
  expect(afterSubmit.panelScrollLeft).toBe(0);
});
