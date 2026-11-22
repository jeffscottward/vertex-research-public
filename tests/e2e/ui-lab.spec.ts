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

test("panel actions and return analysis fit at 375 px without horizontal scroll after submit", async ({
  page,
}) => {
  await page.setViewportSize({ height: 812, width: 375 });
  await page.goto("/lab/charts");
  await expectHydrated(page.locator("[data-lab-frame]"));

  const chartPanel = page.locator('[data-chart-panel][data-slot="panel"]');
  const returnAnalysis = page.locator(
    '[data-return-analysis][data-slot="panel"]'
  );
  await expect(
    chartPanel.getByRole("link", { name: "Options chain" })
  ).toBeVisible();
  await expect(returnAnalysis).toBeVisible();

  const measure = async () => {
    const chart = await chartPanel.evaluate((section) => {
      const header = section.querySelector<HTMLElement>(
        '[data-slot="panel-header"]'
      );
      const actions = section.querySelector<HTMLElement>(
        '[data-slot="panel-actions"]'
      );
      if (header === null || actions === null) {
        throw new Error("Expected panel-header and panel-actions slots");
      }
      const sectionRect = section.getBoundingClientRect();
      const actionsRect = actions.getBoundingClientRect();
      return {
        actionsOverflowRight: Math.round(actionsRect.right - sectionRect.right),
        headerOverflow: header.scrollWidth - header.clientWidth,
        panelScrollLeft: section.scrollLeft,
      };
    });
    const analysis = await returnAnalysis.evaluate((section) => ({
      bodyOverflow: section.scrollWidth - section.clientWidth,
      panelScrollLeft: section.scrollLeft,
    }));
    const docOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    return { analysis, chart, docOverflow };
  };

  const beforeSubmit = await measure();
  expect(beforeSubmit.chart.headerOverflow).toBe(0);
  expect(beforeSubmit.chart.actionsOverflowRight).toBeLessThanOrEqual(0);
  expect(beforeSubmit.chart.panelScrollLeft).toBe(0);
  expect(beforeSubmit.analysis.bodyOverflow).toBe(0);
  expect(beforeSubmit.analysis.panelScrollLeft).toBe(0);
  expect(beforeSubmit.docOverflow).toBe(0);

  await chartPanel.getByLabel("Symbol").fill("NVDA");
  await chartPanel.getByRole("button", { exact: true, name: "Open" }).click();
  await expect(
    chartPanel.getByRole("heading", { name: "NVDA · 1D" })
  ).toBeVisible();
  await expect(
    chartPanel.getByRole("link", { name: "Options chain" })
  ).toBeVisible();
  await expect(returnAnalysis).toBeVisible();

  const afterSubmit = await measure();
  expect(afterSubmit.chart.headerOverflow).toBe(0);
  expect(afterSubmit.chart.actionsOverflowRight).toBeLessThanOrEqual(0);
  expect(afterSubmit.chart.panelScrollLeft).toBe(0);
  expect(afterSubmit.analysis.bodyOverflow).toBe(0);
  expect(afterSubmit.analysis.panelScrollLeft).toBe(0);
  expect(afterSubmit.docOverflow).toBe(0);
});
