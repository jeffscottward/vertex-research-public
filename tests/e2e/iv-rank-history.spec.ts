// O20 IV rank / percentile history chart in the UI lab (/lab/stock & /lab/charts).
// Verifies SVG chart rendering, High/Low bands, horizon switching, series toggle guard,
// detail table, calm unavailable state for non-Core-7 tickers, and zero horizontal overflow
// at 375 px and 1440 px in both dark and light modes.
import { expect, expectHydrated, test } from "./fixtures.ts";

test("renders SPY IV rank / percentile history on analytics tab with horizon and series controls", async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto("/lab/stock?symbol=SPY&tab=analytics");
  await expectHydrated(page.locator("[data-lab-frame]"));

  const panel = page.locator('[data-iv-history="SPY"]');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-iv-history-state="ready"]')).toBeVisible();
  await expect(panel.locator('[data-iv-basis="vol_index_proxy"]')).toHaveText(
    "Proxy: VIX"
  );
  await expect(panel.locator('[data-iv-band="high"]')).toBeVisible();
  await expect(panel.locator('[data-iv-band="low"]')).toBeVisible();
  await expect(panel.locator('[data-series="iv-rank"]').first()).toBeVisible();
  await expect(panel.locator('[data-series="iv-percentile"]')).toBeVisible();

  // Switch horizon to 3M and 2Y
  await panel.getByText("3M", { exact: true }).click();
  await expect(panel.locator("[data-iv-history-chart]")).toHaveAttribute(
    "aria-label",
    /\(3M,/
  );
  await panel.getByText("2Y", { exact: true }).click();
  await expect(panel.locator("[data-iv-history-chart]")).toHaveAttribute(
    "aria-label",
    /\(2Y,/
  );

  // Toggle IV Percentile off -> IV Rank becomes disabled so chart cannot go blank
  const rankToggle = panel.getByRole("button", {
    exact: true,
    name: "IV Rank",
  });
  const pctlToggle = panel.getByRole("button", {
    exact: true,
    name: "IV Percentile",
  });
  await pctlToggle.click();
  await expect(pctlToggle).toHaveAttribute("aria-pressed", "false");
  await expect(rankToggle).toBeDisabled();
  await expect(panel.locator('[data-series="iv-percentile"]')).toHaveCount(0);

  // Re-enable IV Percentile and inspect detail table
  await pctlToggle.click();
  await expect(rankToggle).toBeEnabled();
  await panel.locator("details summary").click();
  await expect(panel.locator("[data-iv-history-table]")).toBeVisible();

  // Dark and light modes at 1440 px and 375 px have zero horizontal overflow
  for (const width of [1440, 375]) {
    await page.setViewportSize({ height: 812, width });
    for (const theme of ["default-dark", "default-light"] as const) {
      await page.evaluate((nextTheme) => {
        document.documentElement.dataset["theme"] = nextTheme;
      }, theme);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth
      );
      expect(overflow).toBeLessThanOrEqual(0);
    }
  }
});

test("renders calm unavailable state without error badges for non-Core-7 NVDA", async ({
  page,
}) => {
  await page.setViewportSize({ height: 812, width: 375 });
  await page.goto("/lab/stock?symbol=NVDA&tab=analytics");
  await expectHydrated(page.locator("[data-lab-frame]"));

  const panel = page.locator('[data-iv-history="NVDA"]');
  await expect(panel).toBeVisible();
  const status = panel.locator('[data-iv-history-state="unavailable"]');
  await expect(status).toBeVisible();
  await expect(status).toContainText("0 / 252 own ATM IV sessions stored");
  await expect(panel.locator("[data-error-code]")).toHaveCount(0);
  await expect(panel.locator('[role="alert"]')).toHaveCount(0);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
